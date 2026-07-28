import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readUtf8, sourceEvidence } from './source.ts'
import type {
  DiscoveredCapability,
  DynamicReport,
  Evidence,
  GapResult,
} from './types.ts'

type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { code?: number; message?: string; data?: unknown }
}

function runtimeEvidence(path: string, detail: string): Evidence {
  return { path, line: 1, detail, evidenceType: 'runtime' }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function redactLine(line: string): string {
  return line
    .replace(/(api[_-]?key|token|authorization|password)[=:]\s*\S+/gi, '$1=<redacted>')
    .slice(0, 2_000)
}

export async function runAcpProbe(options: {
  agentPath: string
  vendorRoot: string
  vendorCommit: string
  staticCapabilities: DiscoveredCapability[]
}): Promise<DynamicReport> {
  const probeRoot = '/tmp/deepharness-capability-probe'
  const home = join(probeRoot, 'home')
  const workspace = join(probeRoot, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })

  const command = ['bun', options.agentPath, '--acp']
  const child = spawn('bun', [options.agentPath, '--acp'], {
    cwd: workspace,
    stdio: 'pipe',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      NODE_ENV: 'production',
      USER_TYPE: 'external',
      ...(process.env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
        : {}),
      ...(process.env.ANTHROPIC_BASE_URL
        ? { ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL }
        : {}),
    },
  })

  const responses = new Map<number | string, JsonRpcMessage>()
  const notifications: JsonRpcMessage[] = []
  const stderr: string[] = []
  let stdoutBuffer = ''
  let stderrBuffer = ''

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line) as JsonRpcMessage
        if (message.id !== undefined) responses.set(message.id, message)
        else notifications.push(message)
      } catch (error) {
        notifications.push({
          method: 'probe/non-json-stdout',
          params: { line: line.slice(0, 500), error: String(error) },
        })
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk
    const lines = stderrBuffer.split('\n')
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim()) stderr.push(redactLine(line))
    }
  })

  function send(id: number, method: string, params: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }

  function notify(method: string, params: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  async function response(id: number, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const message = responses.get(id)
      if (message) {
        if (message.error) {
          throw new Error(
            `ACP request ${id} failed: ${message.error.code ?? 'unknown'} ${message.error.message ?? ''}`,
          )
        }
        return message.result ?? {}
      }
      if (child.exitCode !== null) {
        throw new Error(`ACP agent exited with code ${child.exitCode}: ${stderr.slice(-20).join('\n')}`)
      }
      await wait(25)
    }
    throw new Error(`Timed out waiting for ACP response ${id}: ${stderr.slice(-20).join('\n')}`)
  }

  let initialize: Record<string, unknown> = {}
  let newSession: Record<string, unknown> = {}
  let promptResponse: Record<string, unknown> = {}
  let promptText = ''
  let promptTextUpdates = 0
  let cancelResponse: Record<string, unknown> = {}
  let observedCancelStreamUpdate = false
  try {
    send(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'deepharness-vendor-audit', version: '0.0.0' },
    })
    initialize = await response(1)
    send(2, 'session/new', { cwd: workspace, mcpServers: [] })
    newSession = await response(2)
    await wait(1_000)
    const sessionId = newSession.sessionId
    if (typeof sessionId !== 'string') throw new Error('ACP session/new returned no sessionId')

    const promptStart = notifications.length
    send(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with the exact words STREAM OK.' }],
    })
    promptResponse = await response(3, 60_000)
    const promptNotifications = notifications.slice(promptStart)
    const textUpdates = promptNotifications
      .filter(message => message.method === 'session/update')
      .map(message => message.params?.update)
      .filter(
        (update): update is Record<string, unknown> =>
          typeof update === 'object' &&
          update !== null &&
          'sessionUpdate' in update &&
          update.sessionUpdate === 'agent_message_chunk',
      )
      .map(update => update.content)
      .filter(
        (content): content is Record<string, unknown> =>
          typeof content === 'object' &&
          content !== null &&
          'type' in content &&
          content.type === 'text',
      )
    promptText = textUpdates.map(content => String(content.text ?? '')).join('')
    promptTextUpdates = textUpdates.length
    if (!promptText.includes('STREAM OK')) {
      throw new Error(`ACP prompt did not stream expected text: ${promptText.slice(0, 500)}`)
    }

    const cancelStart = notifications.length
    send(4, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '[slow] continue until cancelled' }],
    })
    const updateDeadline = Date.now() + 10_000
    while (Date.now() < updateDeadline) {
      observedCancelStreamUpdate = notifications.slice(cancelStart).some(message => {
        const update = message.params?.update as Record<string, unknown> | undefined
        return message.method === 'session/update' && update?.sessionUpdate === 'agent_message_chunk'
      })
      if (observedCancelStreamUpdate) break
      await wait(25)
    }
    notify('session/cancel', { sessionId })
    cancelResponse = await response(4, 30_000)
    if (cancelResponse.stopReason !== 'cancelled') {
      throw new Error(`ACP cancel returned ${String(cancelResponse.stopReason)}`)
    }
  } finally {
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>(resolve => child.once('exit', () => resolve())),
      wait(3_000),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  const availableCommands = notifications
    .filter(message => message.method === 'session/update')
    .map(message => message.params?.update)
    .filter(
      (update): update is Record<string, unknown> =>
        typeof update === 'object' &&
        update !== null &&
        (update as Record<string, unknown>).sessionUpdate === 'available_commands_update',
    )
    .flatMap(update =>
      Array.isArray(update.availableCommands)
        ? update.availableCommands.filter(
            (command): command is Record<string, unknown> =>
              typeof command === 'object' && command !== null,
          )
        : [],
    )

  const gaps = await evaluateKnownGaps({
    vendorRoot: options.vendorRoot,
    initialize,
    availableCommands,
    staticCapabilities: options.staticCapabilities,
  })

  return {
    schema_version: 1,
    vendor_commit: options.vendorCommit,
    generated_at: new Date().toISOString(),
    probe: 'ccb-bun-acp-stdio',
    command,
    initialize,
    new_session: newSession,
    prompt: {
      response: promptResponse,
      text: promptText,
      text_updates: promptTextUpdates,
    },
    cancel: {
      response: cancelResponse,
      observed_stream_update: observedCancelStreamUpdate,
    },
    stdout_protocol_errors: notifications
      .filter(message => message.method === 'probe/non-json-stdout')
      .map(message => String(message.params?.line ?? 'unknown')),
    available_commands: availableCommands,
    notifications_observed: notifications.length,
    stderr_tail: stderr.slice(-50),
    gaps,
  }
}

async function evaluateKnownGaps(options: {
  vendorRoot: string
  initialize: Record<string, unknown>
  availableCommands: Array<Record<string, unknown>>
  staticCapabilities: DiscoveredCapability[]
}): Promise<GapResult[]> {
  const capabilities = options.initialize.agentCapabilities as
    | Record<string, unknown>
    | undefined
  const promptCapabilities = capabilities?.promptCapabilities as
    | Record<string, unknown>
    | undefined

  const promptConversionPath = join(
    options.vendorRoot,
    'src/services/acp/promptConversion.ts',
  )
  const promptConversion = await readUtf8(promptConversionPath)
  const hasImageBranch = /(?:case\s+['"]image['"]|block\.type\s*===\s*['"]image['"])/.test(
    promptConversion,
  )
  const imageBlocked = promptCapabilities?.image === false && !hasImageBranch

  const createSessionPath = join(
    options.vendorRoot,
    'src/services/acp/agent/createSessionMethod.ts',
  )
  const createSession = await readUtf8(createSessionPath)
  const mcpClientsIndex = createSession.indexOf('mcpClients: []')
  const mcpBlocked = mcpClientsIndex >= 0

  const localCommands = options.staticCapabilities.filter(
    capability =>
      capability.kind === 'command' &&
      (capability.id.startsWith('command.local.') ||
        capability.id.startsWith('command.local-jsx.')),
  )
  const publishedNames = new Set(
    options.availableCommands
      .map(command => command.name)
      .filter((name): name is string => typeof name === 'string'),
  )
  const leakedLocal = localCommands.filter(command => publishedNames.has(command.name))
  const commandProbeComplete = localCommands.length > 0 && options.availableCommands.length > 0
  const localBlocked = commandProbeComplete && leakedLocal.length === 0

  const strategy =
    'Prefer a generic upstream ACP fix, then consume a verified vendor update; use an external protocol adapter only when it does not import vendor internals.'
  const packagePath = join(options.vendorRoot, 'package.json')
  const packageContent = await readUtf8(packagePath)
  const packageVersion = (JSON.parse(packageContent) as { version?: string }).version
  const agentInfo = options.initialize.agentInfo as Record<string, unknown> | undefined
  const advertisedVersion = agentInfo?.version
  const versionDrift =
    typeof packageVersion === 'string' &&
    typeof advertisedVersion === 'string' &&
    packageVersion !== advertisedVersion
  return [
    {
      id: 'gap.acp.image-input',
      status: imageBlocked ? 'expected_failure' : 'unexpected_pass',
      summary: imageBlocked
        ? 'ACP advertises image:false and prompt conversion has no image branch.'
        : 'Image behavior changed and requires manual reclassification.',
      evidence: [
        runtimeEvidence(
          'acp.initialize.agentCapabilities.promptCapabilities.image',
          `observed=${String(promptCapabilities?.image)}`,
        ),
        sourceEvidence(
          options.vendorRoot,
          promptConversionPath,
          promptConversion,
          0,
          'No image conversion branch found',
        ),
      ],
      upstream_strategy: strategy,
    },
    {
      id: 'gap.acp.dynamic-mcp-tools',
      status: mcpBlocked ? 'expected_failure' : 'unexpected_pass',
      summary: mcpBlocked
        ? 'ACP createSession still constructs QueryEngine with mcpClients: [].'
        : 'MCP wiring changed and requires a real invocation contract test before support is claimed.',
      evidence: [
        sourceEvidence(
          options.vendorRoot,
          createSessionPath,
          createSession,
          Math.max(mcpClientsIndex, 0),
          'QueryEngine ACP configuration',
        ),
        runtimeEvidence(
          'acp.initialize.agentCapabilities.mcpCapabilities',
          `advertised=${JSON.stringify(capabilities?.mcpCapabilities ?? null)}`,
        ),
      ],
      upstream_strategy: strategy,
    },
    {
      id: 'gap.acp.local-commands',
      status: commandProbeComplete
        ? localBlocked
          ? 'expected_failure'
          : 'unexpected_pass'
        : 'probe_error',
      summary: commandProbeComplete
        ? localBlocked
          ? `${localCommands.length} local/local-jsx commands were absent from ACP available commands.`
          : `ACP unexpectedly published local commands: ${leakedLocal.map(command => command.name).join(', ')}`
        : `Command comparison incomplete: static=${localCommands.length}, advertised=${options.availableCommands.length}.`,
      evidence: [
        runtimeEvidence(
          'acp.session.update.available_commands_update',
          `advertised=${options.availableCommands.length}, local_static=${localCommands.length}`,
        ),
        ...localCommands.slice(0, 3).flatMap(command => command.source_evidence),
      ],
      upstream_strategy: strategy,
    },
    {
      id: 'gap.acp.agent-version-drift',
      status: versionDrift ? 'expected_failure' : 'unexpected_pass',
      summary: versionDrift
        ? `ACP agentInfo.version=${String(advertisedVersion)} differs from vendor package version=${String(packageVersion)}.`
        : 'ACP runtime version metadata changed and requires release metadata verification.',
      evidence: [
        runtimeEvidence('acp.initialize.agentInfo.version', `observed=${String(advertisedVersion)}`),
        sourceEvidence(
          options.vendorRoot,
          packagePath,
          packageContent,
          packageContent.indexOf('"version"'),
          `vendor package version=${String(packageVersion)}`,
        ),
      ],
      upstream_strategy: strategy,
    },
  ]
}

export function dynamicAcpCapabilities(
  report: DynamicReport,
): DiscoveredCapability[] {
  const root = report.initialize.agentCapabilities
  if (!root || typeof root !== 'object' || Array.isArray(root)) return []
  const capabilities: DiscoveredCapability[] = []

  function visit(value: unknown, path: string[]): void {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length === 0) {
        add(true, path)
      } else {
        for (const [key, child] of entries) visit(child, [...path, key])
      }
      return
    }
    add(value, path)
  }

  function add(value: unknown, path: string[]): void {
    const name = `advertised:${path.join('.')}`
    const imageBlocked = path.join('.') === 'promptCapabilities.image' && value === false
    capabilities.push({
      id: `acp.${name}`,
      kind: 'acp',
      name,
      compiled: true,
      enabled: value !== false,
      advertised_by_acp: true,
      invocable: imageBlocked ? false : null,
      ui_supported: false,
      tested: true,
      conditions: [],
      source_evidence: [
        runtimeEvidence(`acp.initialize.agentCapabilities.${path.join('.')}`, `observed=${JSON.stringify(value)}`),
      ],
      known_gap: imageBlocked ? 'ACP explicitly disables image input.' : null,
      last_test_result: imageBlocked ? 'expected_failure' : 'passed',
    })
  }

  visit(root, [])
  const version = (report.initialize.agentInfo as Record<string, unknown> | undefined)?.version
  const versionGap = report.gaps.find(gap => gap.id === 'gap.acp.agent-version-drift')
  capabilities.push({
    id: 'acp.agentInfo.version',
    kind: 'acp',
    name: 'agentInfo.version',
    compiled: true,
    enabled: true,
    advertised_by_acp: true,
    invocable: null,
    ui_supported: false,
    tested: true,
    conditions: [],
    source_evidence: [
      runtimeEvidence('acp.initialize.agentInfo.version', `observed=${String(version)}`),
    ],
    known_gap: versionGap?.status === 'expected_failure' ? versionGap.summary : null,
    last_test_result: versionGap?.status === 'expected_failure' ? 'expected_failure' : 'passed',
  })
  for (const [name, path, uiSupported] of [
    ['initialize', 'acp.initialize', false],
    ['newSession', 'acp.session.new', false],
    ['prompt', 'acp.session.prompt', true],
    ['cancel', 'acp.session.cancel', true],
  ] as const) {
    capabilities.push({
      id: `acp.${name}`,
      kind: 'acp',
      name,
      compiled: true,
      enabled: true,
      advertised_by_acp: true,
      invocable: true,
      ui_supported: uiSupported,
      tested: true,
      conditions: [],
      source_evidence: [runtimeEvidence(path, 'Real ccb-bun ACP request completed successfully')],
      known_gap: null,
      last_test_result: 'passed',
    })
  }
  capabilities.push({
    id: 'acp.sessionUpdate.text',
    kind: 'acp',
    name: 'sessionUpdate.text',
    compiled: true,
    enabled: true,
    advertised_by_acp: true,
    invocable: true,
    ui_supported: true,
    tested: report.prompt.text_updates > 0,
    conditions: ['content_block:text'],
    source_evidence: [
      runtimeEvidence(
        'acp.session.update.agent_message_chunk',
        `Observed ${report.prompt.text_updates} streaming text updates from real ccb-bun ACP`,
      ),
    ],
    known_gap: null,
    last_test_result: report.prompt.text_updates > 0 ? 'passed' : 'not_tested',
  })
  return capabilities.sort((a, b) => a.id.localeCompare(b.id))
}

export function dynamicCommandCapabilities(
  report: DynamicReport,
): DiscoveredCapability[] {
  return report.available_commands
    .flatMap(command => {
      const name = command.name
      if (typeof name !== 'string' || name.length === 0) return []
      return [{
        id: `command.prompt.${name}`,
        kind: 'command' as const,
        name,
        compiled: true,
        enabled: true,
        advertised_by_acp: true,
        invocable: null,
        ui_supported: false,
        tested: true,
        conditions: ['command_type:prompt'],
        source_evidence: [
          runtimeEvidence(
            `acp.session.update.available_commands_update.${name}`,
            'Prompt command advertised by the real ACP session',
          ),
        ],
        known_gap: null,
        last_test_result: 'passed' as const,
      }]
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}
