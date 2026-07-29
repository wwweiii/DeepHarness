import type {
  ExtensionEntry,
  JsonValue,
  McpServerStatus,
} from '@deepharness/protocol'
import { access, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

type SettingsSource = 'user' | 'project' | 'local'
type JsonObject = Record<string, unknown>

interface SettingsDocument {
  source: SettingsSource
  path: string
  value: JsonObject
}

export interface DiscoveredExtensions {
  extensions: ExtensionEntry[]
  mcpServers: McpServerStatus[]
  acpMcpServers: JsonObject[]
  sourceErrors: string[]
}

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {}
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missing(error: unknown): boolean {
  return record(error).code === 'ENOENT'
}

async function readJson(pathname: string, label: string, errors: string[]): Promise<JsonObject | null> {
  try {
    const raw = await readFile(pathname, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${label}: expected a JSON object`)
      return null
    }
    return parsed as JsonObject
  } catch (error) {
    if (!missing(error)) errors.push(`${label}: ${errorMessage(error)}`)
    return null
  }
}

function frontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith('---\n')) return {}
  const end = markdown.indexOf('\n---', 4)
  if (end < 0) return {}
  const result: Record<string, string> = {}
  for (const line of markdown.slice(4, end).split('\n')) {
    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key && value) result[key] = value
  }
  return result
}

async function skillEntries(
  root: string,
  source: SettingsSource,
  errors: string[],
): Promise<ExtensionEntry[]> {
  const entries: ExtensionEntry[] = []
  let directories
  try {
    directories = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (!missing(error)) errors.push(`${source} skills: ${errorMessage(error)}`)
    return entries
  }
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const pathname = path.join(root, directory.name, 'SKILL.md')
    try {
      const metadata = frontmatter(await readFile(pathname, 'utf8'))
      entries.push({
        id: `skill:${source}:${directory.name}`,
        kind: 'skill',
        name: metadata.name ?? directory.name,
        source,
        path: pathname,
        enabled: true,
        status: 'ready',
        condition: source === 'user' ? 'user scope' : 'workspace pre-approved directory',
        error: null,
        metadata: {
          directory: directory.name,
          description: metadata.description ?? '',
        },
      })
    } catch (error) {
      if (!missing(error)) {
        entries.push({
          id: `skill:${source}:${directory.name}`,
          kind: 'skill',
          name: directory.name,
          source,
          path: pathname,
          enabled: false,
          status: 'error',
          condition: 'SKILL.md must be readable UTF-8 text',
          error: errorMessage(error),
          metadata: {},
        })
      }
    }
  }
  return entries
}

function settingsEntries(documents: SettingsDocument[]): ExtensionEntry[] {
  return documents.map(document => ({
    id: `setting:${document.source}:${path.basename(document.path)}`,
    kind: 'setting',
    name: path.basename(document.path),
    source: document.source,
    path: document.path,
    enabled: true,
    status: 'ready',
    condition: 'Loaded by vendor settings precedence',
    error: null,
    metadata: {
      keys: Object.keys(document.value).sort(),
      credentialValuesProjected: false,
    },
  }))
}

function pluginEntries(documents: SettingsDocument[], errors: string[]): ExtensionEntry[] {
  const plugins = new Map<string, { enabled: boolean; source: SettingsSource; path: string }>()
  for (const document of documents) {
    for (const [name, value] of Object.entries(record(document.value.enabledPlugins))) {
      plugins.set(name, { enabled: value === true, source: document.source, path: document.path })
    }
  }
  return [...plugins].map(([name, state]) => ({
    id: `plugin:${name}`,
    kind: 'plugin',
    name,
    source: state.source,
    path: state.path,
    enabled: state.enabled,
    status: state.enabled ? 'ready' : 'disabled',
    condition: 'settings.enabledPlugins; changes require Agent process restart',
    error: null,
    metadata: {
      settingsSource: state.source,
      loadErrorsIsolated: true,
      discoveryErrors: errors.filter(error => error.toLowerCase().includes('plugin')),
    },
  }))
}

function hookEntries(documents: SettingsDocument[]): ExtensionEntry[] {
  const entries: ExtensionEntry[] = []
  for (const document of documents) {
    const hooks = record(document.value.hooks)
    const disabled = document.value.disableAllHooks === true
    for (const [eventName, definitions] of Object.entries(hooks)) {
      const count = Array.isArray(definitions) ? definitions.length : 1
      entries.push({
        id: `hook:${document.source}:${eventName}`,
        kind: 'hook',
        name: eventName,
        source: document.source,
        path: document.path,
        enabled: !disabled,
        status: disabled ? 'disabled' : 'ready',
        condition: 'settings hooks; global toggle writes disableAllHooks in settings.local.json',
        error: null,
        metadata: {
          definitionCount: count,
          commandBodiesProjected: false,
        },
      })
    }
  }
  return entries
}

function builtInExtensionEntries(): ExtensionEntry[] {
  const skillSearchEnabled = /^(1|true)$/i.test(process.env.SKILL_SEARCH_ENABLED ?? '')
  const extraToolsEnabled = !/^(0|false)$/i.test(process.env.ENABLE_SEARCH_EXTRA_TOOLS ?? '1')
  return [
    {
      id: 'extra_tool:SkillTool',
      kind: 'extra_tool',
      name: 'SkillTool',
      source: 'vendor',
      path: null,
      enabled: true,
      status: 'ready',
      condition: 'Vendor tool registry; execution is observed through ACP tool events',
      error: null,
      metadata: { renderer: 'generic', executionSurface: 'ACP' },
    },
    {
      id: 'extra_tool:DiscoverSkillsTool',
      kind: 'extra_tool',
      name: 'DiscoverSkillsTool',
      source: 'vendor',
      path: null,
      enabled: skillSearchEnabled,
      status: skillSearchEnabled ? 'ready' : 'disabled',
      condition: 'EXPERIMENTAL_SKILL_SEARCH build plus SKILL_SEARCH_ENABLED opt-in',
      error: null,
      metadata: { renderer: 'generic', executionSurface: 'ACP' },
    },
    {
      id: 'extra_tool:SearchExtraToolsTool',
      kind: 'extra_tool',
      name: 'SearchExtraToolsTool',
      source: 'vendor',
      path: null,
      enabled: extraToolsEnabled,
      status: extraToolsEnabled ? 'ready' : 'disabled',
      condition: 'ENABLE_SEARCH_EXTRA_TOOLS runtime policy',
      error: null,
      metadata: { renderer: 'generic', executionSurface: 'ACP' },
    },
    {
      id: 'extra_tool:ExecuteExtraTool',
      kind: 'extra_tool',
      name: 'ExecuteExtraTool',
      source: 'vendor',
      path: null,
      enabled: extraToolsEnabled,
      status: extraToolsEnabled ? 'ready' : 'disabled',
      condition: 'SearchExtraTools discovery must select a deferred tool first',
      error: null,
      metadata: { renderer: 'generic', executionSurface: 'ACP' },
    },
  ]
}

function safeEndpoint(config: JsonObject): string | null {
  if (typeof config.url !== 'string') {
    return typeof config.command === 'string' ? path.basename(config.command) : null
  }
  try {
    const url = new URL(config.url)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '<invalid-url>'
  }
}

function namedStringValues(value: unknown): JsonObject[] {
  return Object.entries(record(value)).flatMap(([name, item]) =>
    typeof item === 'string' ? [{ name, value: item }] : [])
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function validUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function mcpStatus(
  name: string,
  source: SettingsSource,
  config: JsonObject,
): McpServerStatus {
  const transport = typeof config.type === 'string'
    ? config.type
    : typeof config.url === 'string' ? 'http' : 'stdio'
  const remote = transport === 'http' || transport === 'sse'
  const invalid = (remote && !validUrl(config.url))
    || (transport === 'stdio' && typeof config.command !== 'string')
    || (!remote && transport !== 'stdio')
  const hasAuthMaterial = Object.keys(record(config.headers)).length > 0
    || Object.keys(record(config.env)).length > 0
    || typeof config.oauth === 'object'
  const blockedReason = invalid
    ? remote
      ? 'Remote MCP server requires a valid URL.'
      : transport === 'stdio'
        ? 'Stdio MCP server requires a command.'
        : `Unsupported MCP transport: ${transport}.`
    : 'Vendor ACP accepts MCP configuration but constructs QueryEngine with mcpClients=[], so tools, resources, and OAuth are not reachable.'
  return {
    name,
    source,
    transport,
    endpoint: safeEndpoint(config),
    enabled: config.disabled !== true,
    health: invalid ? 'error' : config.disabled === true ? 'disabled' : 'blocked',
    authStatus: hasAuthMaterial ? 'configured' : remote ? 'unknown' : 'not_required',
    supportsTools: false,
    supportsResources: false,
    resources: [],
    error: invalid ? 'Invalid MCP configuration' : null,
    blockedReason,
    metadata: {
      configurationValidated: !invalid,
      credentialValuesProjected: false,
      acpAdvertisedTransport: remote,
    },
  }
}

function mcpEntries(
  documents: SettingsDocument[],
  mcpFile: JsonObject | null,
): { statuses: McpServerStatus[]; acp: JsonObject[] } {
  const configs = new Map<string, { source: SettingsSource; config: JsonObject }>()
  for (const document of documents) {
    for (const [name, value] of Object.entries(record(document.value.mcpServers))) {
      configs.set(name, { source: document.source, config: record(value) })
    }
  }
  for (const [name, value] of Object.entries(record(mcpFile?.mcpServers))) {
    configs.set(name, { source: 'project', config: record(value) })
  }
  const statuses: McpServerStatus[] = []
  const acp: JsonObject[] = []
  for (const [name, value] of configs) {
    const status = mcpStatus(name, value.source, value.config)
    statuses.push(status)
    if (!status.enabled || status.error) continue
    if ((status.transport === 'http' || status.transport === 'sse')
      && typeof value.config.url === 'string') {
      acp.push({
        name,
        type: status.transport,
        url: value.config.url,
        headers: namedStringValues(value.config.headers),
      })
    } else if (status.transport === 'stdio' && typeof value.config.command === 'string') {
      acp.push({
        name,
        command: value.config.command,
        args: stringValues(value.config.args),
        env: namedStringValues(value.config.env),
      })
    }
  }
  return { statuses, acp }
}

export async function discoverExtensions(cwd: string): Promise<DiscoveredExtensions> {
  const errors: string[] = []
  const userRoot = path.resolve(process.env.HOME ?? '/home/agent')
  const candidates: Array<{ source: SettingsSource; path: string }> = [
    { source: 'user', path: path.join(userRoot, '.claude', 'settings.json') },
    { source: 'project', path: path.join(cwd, '.claude', 'settings.json') },
    { source: 'local', path: path.join(cwd, '.claude', 'settings.local.json') },
  ]
  const documents: SettingsDocument[] = []
  for (const candidate of candidates) {
    const value = await readJson(candidate.path, `${candidate.source} settings`, errors)
    if (value) documents.push({ ...candidate, value })
  }
  const mcpFile = await readJson(path.join(cwd, '.mcp.json'), 'project MCP registry', errors)
  const skills = (await Promise.all([
    skillEntries(path.join(userRoot, '.claude', 'skills'), 'user', errors),
    skillEntries(path.join(cwd, '.claude', 'skills'), 'project', errors),
  ])).flat()
  const mcp = mcpEntries(documents, mcpFile)
  const invalidSettings = errors.map((error, index): ExtensionEntry => ({
    id: `setting:error:${index}`,
    kind: 'setting',
    name: 'load error',
    source: error.startsWith('user') ? 'user' : 'project',
    path: null,
    enabled: false,
    status: 'error',
    condition: 'Each source is isolated; a failed source does not abort session discovery',
    error,
    metadata: {},
  }))
  return {
    extensions: [
      ...skills,
      ...settingsEntries(documents),
      ...pluginEntries(documents, errors),
      ...hookEntries(documents),
      ...builtInExtensionEntries(),
      ...invalidSettings,
    ].map(entry => ({ ...entry, metadata: jsonValue(entry.metadata) as Record<string, JsonValue> })),
    mcpServers: mcp.statuses,
    acpMcpServers: mcp.acp,
    sourceErrors: errors,
  }
}

async function assertWritableSettingsPath(pathname: string): Promise<void> {
  const directory = path.dirname(pathname)
  for (const candidate of [directory, pathname]) {
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        throw new Error(`Refusing to write extension settings through a symlink: ${candidate}`)
      }
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
}

export async function setExtensionEnabled(input: {
  cwd: string
  kind: 'plugin' | 'hook'
  name: string
  enabled: boolean
}): Promise<void> {
  const directory = path.join(input.cwd, '.claude')
  const pathname = path.join(directory, 'settings.local.json')
  await assertWritableSettingsPath(pathname)
  await mkdir(directory, { recursive: true })
  let settings: JsonObject = {}
  try {
    settings = JSON.parse(await readFile(pathname, 'utf8')) as JsonObject
  } catch (error) {
    if (!missing(error)) throw new Error(`Cannot update invalid settings.local.json: ${errorMessage(error)}`)
  }
  if (input.kind === 'plugin') {
    if (!input.name.includes('@')) throw new Error('Plugin name must use plugin@marketplace format')
    settings.enabledPlugins = {
      ...record(settings.enabledPlugins),
      [input.name]: input.enabled,
    }
  } else {
    if (input.name !== 'all') throw new Error('Only the global Hook toggle is supported')
    settings.disableAllHooks = !input.enabled
  }
  const temporary = `${pathname}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  await rename(temporary, pathname)
  await access(pathname, constants.R_OK)
}
