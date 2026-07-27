import { readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { pathExists, readUtf8, sourceEvidence, sourceFiles } from './source.ts'
import type {
  CapabilityKind,
  DiscoveredCapability,
  StaticReport,
} from './types.ts'

function blankCapability(
  kind: CapabilityKind,
  name: string,
  evidence: DiscoveredCapability['source_evidence'],
  overrides: Partial<DiscoveredCapability> = {},
): DiscoveredCapability {
  return {
    id: `${kind}.${name}`,
    kind,
    name,
    compiled: true,
    enabled: false,
    advertised_by_acp: false,
    invocable: null,
    ui_supported: false,
    tested: false,
    conditions: [],
    source_evidence: evidence,
    known_gap: null,
    last_test_result: 'not_tested',
    ...overrides,
  }
}

function unique(capabilities: DiscoveredCapability[]): DiscoveredCapability[] {
  const byId = new Map<string, DiscoveredCapability>()
  for (const capability of capabilities) {
    const prior = byId.get(capability.id)
    if (!prior) {
      byId.set(capability.id, capability)
      continue
    }
    prior.source_evidence = [...prior.source_evidence, ...capability.source_evidence]
      .filter(
        (evidence, index, all) =>
          all.findIndex(
            candidate =>
              candidate.path === evidence.path &&
              candidate.line === evidence.line &&
              candidate.detail === evidence.detail,
          ) === index,
      )
      .slice(0, 8)
    prior.conditions = [...new Set([...prior.conditions, ...capability.conditions])]
    prior.enabled ||= capability.enabled
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function maskComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, comment => ' '.repeat(comment.length))
}

async function discoverFeatures(
  vendorRoot: string,
  files: string[],
): Promise<DiscoveredCapability[]> {
  const definesPath = join(vendorRoot, 'scripts/defines.ts')
  const defines = await readUtf8(definesPath)
  const arrayStart = defines.indexOf('DEFAULT_BUILD_FEATURES')
  const arrayEnd = defines.indexOf('] as const', arrayStart)
  const defaultBlock = defines.slice(arrayStart, arrayEnd).replace(/\/\/.*$/gm, '')
  const defaults = new Set(
    [...defaultBlock.matchAll(/['"]([A-Z][A-Z0-9_]+)['"]/g)].flatMap(match =>
      match[1] ? [match[1]] : [],
    ),
  )
  const found = new Map<string, DiscoveredCapability>()

  for (const path of files) {
    const content = await readUtf8(path)
    const code = maskComments(content)
    for (const match of code.matchAll(/feature\(\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\)/g)) {
      const name = match[1]
      if (!name) continue
      const evidence = sourceEvidence(
        vendorRoot,
        path,
        content,
        match.index,
        `feature('${name}') reference`,
      )
      const existing = found.get(name)
      if (existing) existing.source_evidence.push(evidence)
      else {
        found.set(
          name,
          blankCapability('feature', name, [evidence], {
            compiled: defaults.has(name),
            enabled: defaults.has(name),
            conditions: defaults.has(name)
              ? ['compiled:default']
              : ['compiled:optional'],
          }),
        )
      }
    }
  }

  for (const name of defaults) {
    const index = defines.indexOf(`'${name}'`, arrayStart)
    const evidence = sourceEvidence(
      vendorRoot,
      definesPath,
      defines,
      index,
      'DEFAULT_BUILD_FEATURES member',
    )
    const existing = found.get(name)
    if (existing) existing.source_evidence.unshift(evidence)
    else {
      found.set(
        name,
        blankCapability('feature', name, [evidence], {
          compiled: true,
          enabled: true,
          conditions: ['compiled:default'],
        }),
      )
    }
  }

  return unique([...found.values()])
}

const DEFAULT_DISABLED_TOOLS = new Set([
  'ConfigTool',
  'CtxInspectTool',
  'DiscoverSkillsTool',
  'LSPTool',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ListPeersTool',
  'MCPTool',
  'McpAuthTool',
  'OverflowTestTool',
  'PowerShellTool',
  'REPLTool',
  'ReviewArtifactTool',
  'SnipTool',
  'SubscribePRTool',
  'SuggestBackgroundPRTool',
  'SyntheticOutputTool',
  'TerminalCaptureTool',
  'TestingPermissionTool',
  'TungstenTool',
  'VerifyPlanExecutionTool',
  'WebBrowserTool',
])

const TOOL_CONDITIONS: Record<string, string[]> = {
  ConfigTool: ['env:USER_TYPE=ant'],
  CtxInspectTool: ['build_feature:CONTEXT_COLLAPSE'],
  DiscoverSkillsTool: [
    'build_feature:EXPERIMENTAL_SKILL_SEARCH',
    'runtime:SKILL_SEARCH_ENABLED',
  ],
  EnterWorktreeTool: ['runtime:worktree_mode'],
  ExitWorktreeTool: ['runtime:worktree_mode'],
  GoalTool: ['build_feature:GOAL'],
  LSPTool: ['env:ENABLE_LSP_TOOL'],
  ListMcpResourcesTool: ['runtime:mcp_client_connected'],
  ListPeersTool: ['build_feature:UDS_INBOX'],
  MCPTool: ['runtime:mcp_client_connected'],
  McpAuthTool: ['runtime:mcp_client_connected'],
  MonitorTool: ['build_feature:MONITOR_TOOL'],
  OverflowTestTool: ['build_feature:OVERFLOW_TEST_TOOL'],
  PowerShellTool: ['runtime:platform_win32_or_powershell_enabled'],
  PushNotificationTool: ['build_feature:KAIROS|KAIROS_PUSH_NOTIFICATION'],
  REPLTool: ['env:USER_TYPE=ant', 'runtime:repl_mode'],
  ReadMcpResourceTool: ['runtime:mcp_client_connected'],
  RemoteTriggerTool: ['build_feature:AGENT_TRIGGERS_REMOTE'],
  ReviewArtifactTool: ['build_feature:REVIEW_ARTIFACT'],
  ScheduleCronTool: ['build_feature:KAIROS'],
  CronCreateTool: ['build_feature:KAIROS'],
  CronDeleteTool: ['build_feature:KAIROS'],
  CronListTool: ['build_feature:KAIROS'],
  SearchExtraToolsTool: ['runtime:ENABLE_SEARCH_EXTRA_TOOLS'],
  SendUserFileTool: ['build_feature:KAIROS'],
  SleepTool: ['build_feature:PROACTIVE|KAIROS'],
  SnipTool: ['build_feature:HISTORY_SNIP'],
  SubscribePRTool: ['build_feature:KAIROS_GITHUB_WEBHOOKS'],
  SuggestBackgroundPRTool: ['env:USER_TYPE=ant'],
  TaskCreateTool: ['runtime:todo_v2'],
  TaskGetTool: ['runtime:todo_v2'],
  TaskListTool: ['runtime:todo_v2'],
  TaskUpdateTool: ['runtime:todo_v2'],
  TerminalCaptureTool: ['build_feature:TERMINAL_PANEL'],
  TestingPermissionTool: ['env:NODE_ENV=test'],
  TungstenTool: ['env:USER_TYPE=ant'],
  VerifyPlanExecutionTool: ['env:CLAUDE_CODE_VERIFY_PLAN=true'],
  WebBrowserTool: ['build_feature:WEB_BROWSER_TOOL'],
  WorkflowTool: ['build_feature:WORKFLOW_SCRIPTS'],
}

async function discoverTools(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const registryPath = join(vendorRoot, 'src/tools.ts')
  const indexPath = join(vendorRoot, 'packages/builtin-tools/src/index.ts')
  const toolsRoot = join(vendorRoot, 'packages/builtin-tools/src/tools')
  const registry = await readUtf8(registryPath)
  const index = await readUtf8(indexPath)
  const names = new Set<string>(['WorkflowTool'])

  for (const content of [registry, index]) {
    for (const match of content.matchAll(/\b([A-Z][A-Za-z0-9]*(?:V2)?Tool)\b/g)) {
      const name = match[1]
      if (name && name !== 'Tool' && name !== 'XTool') names.add(name)
    }
  }
  for (const entry of await readdir(toolsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[A-Z][A-Za-z0-9]*Tool$/.test(entry.name)) {
      names.add(entry.name)
    }
  }

  const capabilities: DiscoveredCapability[] = []
  for (const name of [...names].sort()) {
    const registryIndex = registry.search(new RegExp(`\\b${name}\\b`))
    const indexIndex = index.search(new RegExp(`\\b${name}\\b`))
    let path = registryPath
    let content = registry
    let at = registryIndex
    if (at < 0 && indexIndex >= 0) {
      path = indexPath
      content = index
      at = indexIndex
    }
    if (at < 0) {
      const directoryName = name === 'WorkflowTool' ? '' : name.replace(/V2Tool$/, 'Tool')
      const candidate = join(toolsRoot, directoryName)
      if (directoryName && (await pathExists(candidate))) {
        path = candidate
        content = ''
        at = 0
      }
    }
    const conditions = TOOL_CONDITIONS[name] ?? []
    const enabled = registryIndex >= 0 && !DEFAULT_DISABLED_TOOLS.has(name)
    capabilities.push(
      blankCapability(
        'tool',
        name,
        [
          {
            path: relative(vendorRoot, path),
            line: content ? sourceEvidence(vendorRoot, path, content, at, '').line : 1,
            detail: registryIndex >= 0
              ? 'Referenced by src/tools.ts registry'
              : 'Exported implementation or tool directory candidate',
            evidenceType: 'source',
          },
        ],
        { enabled, conditions },
      ),
    )
  }
  return unique(capabilities)
}

function commandPairs(content: string): Array<{ name: string; type: string; index: number }> {
  const pairs: Array<{ name: string; type: string; index: number }> = []
  const types = [...content.matchAll(/\btype:\s*['"](prompt|local|local-jsx)['"]/g)]
  for (const typeMatch of types) {
    const start = Math.max(0, typeMatch.index - 450)
    const end = Math.min(content.length, typeMatch.index + 650)
    const before = content.slice(start, typeMatch.index)
    const after = content.slice(typeMatch.index, end)
    const afterName = after.match(/\bname:\s*['"]([^'"]+)['"]/)
    const beforeNames = [...before.matchAll(/\bname:\s*['"]([^'"]+)['"]/g)]
    const match = afterName ?? beforeNames.at(-1)
    const name = match?.[1]
    const type = typeMatch[1]
    if (name && type) pairs.push({ name, type, index: typeMatch.index })
  }
  return pairs
}

async function discoverCommands(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const commandsRoot = join(vendorRoot, 'src/commands')
  const files = await sourceFiles(commandsRoot)
  files.push(join(vendorRoot, 'src/commands.ts'))
  const capabilities: DiscoveredCapability[] = []
  for (const path of files) {
    const content = await readUtf8(path)
    for (const pair of commandPairs(content)) {
      capabilities.push(
        blankCapability(
          'command',
          pair.name,
          [sourceEvidence(vendorRoot, path, content, pair.index, `${pair.type} command definition`)],
          {
            id: `command.${pair.type}.${pair.name}`,
            enabled: true,
            conditions: [`command_type:${pair.type}`],
            known_gap: pair.type === 'prompt'
              ? null
              : 'ACP available_commands_update only publishes prompt commands.',
          },
        ),
      )
    }
  }
  return unique(capabilities)
}

async function discoverAgents(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const root = join(vendorRoot, 'packages/builtin-tools/src/tools/AgentTool/built-in')
  const capabilities: DiscoveredCapability[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    const path = join(root, entry.name)
    const content = await readUtf8(path)
    const definition = content.match(/export const ([A-Z0-9_]+_AGENT)\b/)
    const definitionName = definition?.[1]
    if (!definition || !definitionName) continue
    const literal = content.match(/agentType:\s*['"]([^'"]+)['"]/)?.[1]
    const name = literal ?? basename(entry.name, '.ts')
    capabilities.push(
      blankCapability(
        'agent',
        name,
        [sourceEvidence(vendorRoot, path, content, definition.index ?? 0, definitionName)],
        {
          enabled: true,
          conditions: /explore|plan/i.test(name)
            ? ['build_feature:BUILTIN_EXPLORE_PLAN_AGENTS']
            : /verification/i.test(name)
              ? ['build_feature:VERIFICATION_AGENT']
              : [],
        },
      ),
    )
  }
  const loaderPath = join(
    vendorRoot,
    'packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts',
  )
  const loader = await readUtf8(loaderPath)
  capabilities.push(
    blankCapability(
      'agent',
      'custom-agent-definitions',
      [sourceEvidence(vendorRoot, loaderPath, loader, loader.indexOf('getAgentDefinitionsWithOverrides'), 'Dynamic custom/plugin Agent definition loader')],
      { enabled: true, conditions: ['workspace:.claude/agents', 'plugins'] },
    ),
  )
  return unique(capabilities)
}

async function discoverProviders(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const path = join(vendorRoot, 'src/utils/model/providers.ts')
  const content = await readUtf8(path)
  const typeStart = content.indexOf('export type APIProvider')
  const typeEnd = content.indexOf('export function getAPIProvider', typeStart)
  const block = content.slice(typeStart, typeEnd)
  return [...block.matchAll(/['"]([A-Za-z][A-Za-z0-9]+)['"]/g)].map(match => {
    const name = match[1]
    if (!name) throw new Error('APIProvider regex matched without a provider name')
    return blankCapability(
      'provider',
      name,
      [sourceEvidence(vendorRoot, path, content, typeStart + (match.index ?? 0), 'APIProvider union member')],
      {
        enabled: name === 'firstParty',
        conditions: name === 'firstParty'
          ? ['default-provider']
          : [`provider-selection:${name}`],
      },
    )
  })
}

const INTEGRATION_SOURCES: Array<[string, string]> = [
  ['hooks', 'src/hooks'],
  ['plugins', 'src/plugins'],
  ['skills', 'src/skills'],
  ['lsp', 'src/services/lsp'],
  ['telemetry', 'src/services/analytics'],
  ['mcp-runtime', 'src/services/mcp'],
  ['ssh-remote', 'src/services/remote'],
  ['browser', 'src/utils/claudeInChrome'],
  ['voice', 'src/voice'],
  ['scm-github', 'src/commands/install-github-app'],
]

async function discoverIntegrations(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const capabilities: DiscoveredCapability[] = []
  for (const [name, relativePath] of INTEGRATION_SOURCES) {
    const path = join(vendorRoot, relativePath)
    if (!(await pathExists(path))) continue
    capabilities.push(
      blankCapability(
        'integration',
        name,
        [{ path: relativePath, line: 1, detail: 'Integration source root', evidenceType: 'source' }],
        { conditions: ['optional-integration'] },
      ),
    )
  }

  const packageRoots = [join(vendorRoot, 'packages')]
  for (const root of packageRoots) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('@')) continue
      const packagePath = join(root, entry.name, 'package.json')
      if (!(await pathExists(packagePath))) continue
      capabilities.push(
        blankCapability(
          'integration',
          `package:${entry.name}`,
          [{ path: relative(vendorRoot, packagePath), line: 1, detail: 'Vendor package boundary', evidenceType: 'source' }],
          { conditions: ['vendor-package'] },
        ),
      )
    }
    const antRoot = join(root, '@ant')
    if (await pathExists(antRoot)) {
      for (const entry of await readdir(antRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const packagePath = join(antRoot, entry.name, 'package.json')
        if (!(await pathExists(packagePath))) continue
        capabilities.push(
          blankCapability(
            'integration',
            `package:@ant/${entry.name}`,
            [{ path: relative(vendorRoot, packagePath), line: 1, detail: 'Vendor @ant package boundary', evidenceType: 'source' }],
            { conditions: ['vendor-package'] },
          ),
        )
      }
    }
  }
  return unique(capabilities)
}

async function discoverRuntimeFlags(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const roots = [
    'src/tools.ts',
    'src/utils/model/providers.ts',
    'src/utils/tasks.ts',
    'src/utils/searchExtraTools.ts',
    'src/services/skillSearch/featureCheck.ts',
    'src/utils/worktreeModeEnabled.ts',
    'src/utils/shell/shellToolUtils.ts',
    'src/utils/permissions/permissions.ts',
    'src/services/acp',
    'packages/builtin-tools/src/tools/REPLTool/constants.ts',
  ]
  const paths: string[] = []
  for (const item of roots) {
    const path = join(vendorRoot, item)
    if (!(await pathExists(path))) continue
    const info = await import('node:fs/promises').then(module => module.stat(path))
    if (info.isDirectory()) paths.push(...await sourceFiles(path))
    else paths.push(path)
  }
  const capabilities: DiscoveredCapability[] = []
  for (const path of paths) {
    const content = await readUtf8(path)
    for (const match of content.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g)) {
      const name = match[1] ?? match[2]
      if (!name) continue
      capabilities.push(
        blankCapability(
          'runtime_flag',
          name,
          [sourceEvidence(vendorRoot, path, content, match.index, 'Runtime environment condition')],
          { conditions: [`env:${name}`] },
        ),
      )
    }
  }
  const derived: Array<[string, string, string]> = [
    ['TODO_V2', 'src/utils/tasks.ts', 'isTodoV2Enabled'],
    ['WORKTREE_MODE', 'src/utils/worktreeModeEnabled.ts', 'isWorktreeModeEnabled'],
    ['PERMISSION_DENY_RULES', 'src/utils/permissions/permissions.ts', 'getDenyRuleForTool'],
    ['REPL_MODE', 'packages/builtin-tools/src/tools/REPLTool/constants.ts', 'isReplModeEnabled'],
  ]
  for (const [name, relativePath, symbol] of derived) {
    const path = join(vendorRoot, relativePath)
    const content = await readUtf8(path)
    capabilities.push(
      blankCapability(
        'runtime_flag',
        name,
        [sourceEvidence(vendorRoot, path, content, content.indexOf(symbol), `Derived runtime condition: ${symbol}`)],
        { conditions: [`runtime:${name.toLowerCase()}`] },
      ),
    )
  }
  return unique(capabilities)
}

async function discoverAcpSurface(vendorRoot: string): Promise<DiscoveredCapability[]> {
  const root = join(vendorRoot, 'src/services/acp/agent')
  const files = await sourceFiles(root)
  const capabilities: DiscoveredCapability[] = []
  const protocolMethods = [
    'initialize',
    'authenticate',
    'newSession',
    'unstable_resumeSession',
    'loadSession',
    'listSessions',
    'unstable_forkSession',
    'unstable_closeSession',
    'unstable_deleteSession',
    'cancel',
    'setSessionMode',
    'unstable_setSessionModel',
    'prompt',
    'setSessionConfigOption',
  ]
  for (const path of files) {
    const content = await readUtf8(path)
    for (const name of protocolMethods) {
      const pattern = new RegExp(`(?:async\\s+(?:function\\s+)?|\\n\\s{2})${name}\\s*\\(`)
      const match = pattern.exec(content)
      if (!match) continue
      capabilities.push(
        blankCapability(
          'acp',
          name,
          [sourceEvidence(vendorRoot, path, content, match.index, 'ACP Agent method')],
          { enabled: true, advertised_by_acp: true },
        ),
      )
    }
  }
  const acpPath = join(vendorRoot, 'src/services/acp/agent/AcpAgent.ts')
  const acpContent = await readUtf8(acpPath)
  const imageIndex = acpContent.indexOf('image: false')
  capabilities.push(
    blankCapability(
      'acp',
      'prompt.image',
      [sourceEvidence(vendorRoot, acpPath, acpContent, imageIndex, 'initialize advertises image:false')],
      {
        enabled: false,
        advertised_by_acp: true,
        invocable: false,
        tested: true,
        known_gap: 'ACP prompt conversion does not pass image blocks to the model.',
        last_test_result: 'expected_failure',
      },
    ),
  )
  return unique(capabilities)
}

export async function runStaticProbe(
  vendorRoot: string,
  vendorCommit: string,
): Promise<StaticReport> {
  const files = await sourceFiles(vendorRoot)
  const groups = await Promise.all([
    discoverFeatures(vendorRoot, files),
    discoverTools(vendorRoot),
    discoverCommands(vendorRoot),
    discoverAgents(vendorRoot),
    discoverProviders(vendorRoot),
    discoverIntegrations(vendorRoot),
    discoverRuntimeFlags(vendorRoot),
    discoverAcpSurface(vendorRoot),
  ])
  const capabilities = unique(groups.flat())
  const counts: Record<string, number> = {}
  for (const capability of capabilities) {
    counts[capability.kind] = (counts[capability.kind] ?? 0) + 1
  }
  return {
    schema_version: 1,
    vendor_commit: vendorCommit,
    generated_at: new Date().toISOString(),
    probe: 'static-source-audit',
    capabilities,
    counts,
  }
}
