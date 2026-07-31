import type {
  CapabilityKind,
  DiscoveredCapability,
  MatrixClass,
  ReviewEntry,
} from './types.ts'

const C_TOOLS = new Set([
  'CtxInspectTool',
  'MCPTool',
  'McpAuthTool',
  'ReviewArtifactTool',
  'SnipTool',
])
const D_TOOLS = new Set([
  'LSPTool',
  'PowerShellTool',
  'PushNotificationTool',
  'REPLTool',
  'RemoteTriggerTool',
  'SendUserFileTool',
  'SubscribePRTool',
  'SuggestBackgroundPRTool',
  'TerminalCaptureTool',
  'WebBrowserTool',
  'VaultHttpFetchTool',
])
const E_TOOLS = new Set([
  'OverflowTestTool',
  'SyntheticOutputTool',
  'TestingPermissionTool',
  'TungstenTool',
])
const B_TOOLS = new Set([
  'ArtifactTool',
  'AskUserQuestionTool',
  'BriefTool',
  'ConfigTool',
  'DiscoverSkillsTool',
  'ExecuteTool',
  'GoalTool',
  'ListMcpResourcesTool',
  'ListPeersTool',
  'MonitorTool',
  'ReadMcpResourceTool',
  'ReviewArtifactTool',
  'ScheduleCronTool',
  'SearchExtraToolsTool',
  'SendMessageTool',
  'SleepTool',
  'TaskOutputTool',
  'TaskStopTool',
  'TeamCreateTool',
  'TeamDeleteTool',
  'TodoWriteTool',
  'VerifyPlanExecutionTool',
  'WorkflowTool',
])

const C_FEATURES = new Set([
  'CONTEXT_COLLAPSE',
  'HISTORY_SNIP',
  'LAN_PIPES',
  'REVIEW_ARTIFACT',
  'SKILL_LEARNING',
  'TEAMMEM',
  'UDS_INBOX',
])
const D_FEATURES = new Set([
  'AGENT_TRIGGERS_REMOTE',
  'AUTOFIX_PR',
  'BRIDGE_MODE',
  'CHICAGO_MCP',
  'COMMIT_ATTRIBUTION',
  'DIRECT_CONNECT',
  'DOWNLOAD_USER_SETTINGS',
  'IS_LIBC_GLIBC',
  'IS_LIBC_MUSL',
  'KAIROS',
  'KAIROS_CHANNELS',
  'KAIROS_GITHUB_WEBHOOKS',
  'KAIROS_PUSH_NOTIFICATION',
  'NATIVE_CLIENT_ATTESTATION',
  'NATIVE_CLIPBOARD_IMAGE',
  'PIPE_IPC',
  'POWERSHELL_AUTO_MODE',
  'SSH_REMOTE',
  'TERMINAL_PANEL',
  'VOICE_MODE',
  'WEB_BROWSER_TOOL',
  'UPLOAD_USER_SETTINGS',
])
const E_FEATURES = new Set([
  'ABLATION_BASELINE',
  'ALLOW_TEST_VERSIONS',
  'AUTO_THEME',
  'BUDDY',
  'COWORKER_TYPE_TELEMETRY',
  'DAEMON',
  'DUMP_SYSTEM_PROMPT',
  'ENHANCED_TELEMETRY_BETA',
  'FORK_SUBAGENT',
  'HARD_FAIL',
  'HISTORY_PICKER',
  'MEMORY_SHAPE_TELEMETRY',
  'MESSAGE_ACTIONS',
  'OVERFLOW_TEST_TOOL',
  'PERFETTO_TRACING',
  'QUICK_SEARCH',
  'SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED',
  'SLOW_OPERATION_LOGGING',
  'TRANSCRIPT_CLASSIFIER',
])
const B_FEATURES = new Set([
  'ACP',
  'AWAY_SUMMARY',
  'BG_SESSIONS',
  'CONNECTOR_TEXT',
  'COORDINATOR_MODE',
  'EXPERIMENTAL_SEARCH_EXTRA_TOOLS',
  'EXPERIMENTAL_SKILL_SEARCH',
  'EXTRACT_MEMORIES',
  'GOAL',
  'KAIROS_BRIEF',
  'MONITOR_TOOL',
  'LODESTONE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'SHOT_STATS',
  'TEMPLATES',
  'TOKEN_BUDGET',
  'ULTRAPLAN',
  'ULTRATHINK',
  'VERIFICATION_AGENT',
  'WORKFLOW_SCRIPTS',
])

function entry(matrix_class: MatrixClass, rationale: string): ReviewEntry {
  return { matrix_class, rationale }
}

function classifyTool(name: string): ReviewEntry {
  if (C_TOOLS.has(name)) return entry('C', 'Vendor capability is blocked or incomplete on the current ACP path.')
  if (D_TOOLS.has(name)) return entry('D', 'Availability depends on container platform, runtime, credentials, or an external service.')
  if (E_TOOLS.has(name)) return entry('E', 'Internal or test-only capability is not part of the Agent Harness product surface.')
  if (B_TOOLS.has(name) || /^(?:Cron|Task|Team)/.test(name)) {
    return entry('B', 'The kernel capability requires Harness protocol, persistence, or dedicated UI adaptation.')
  }
  return entry('A', 'The tool is assembled by the vendor tool registry and is intended to run natively through ACP sessions.')
}

function classifyFeature(name: string, compiled: boolean): ReviewEntry {
  if (C_FEATURES.has(name)) return entry('C', 'The feature is disabled or has a confirmed ACP reachability gap.')
  if (D_FEATURES.has(name)) return entry('D', 'The feature depends on platform facilities or external integrations.')
  if (E_FEATURES.has(name)) return entry('E', 'The feature is a vendor shell, internal, diagnostic, or superseded capability.')
  if (!compiled) return entry('C', 'The source capability is not compiled into the locked default vendor build.')
  if (B_FEATURES.has(name)) return entry('B', 'The feature is inherited from the kernel but requires Harness adaptation or verification.')
  return entry('A', 'The feature is compiled into the kernel and is expected to be inherited through ACP.')
}

function classifyIntegration(name: string): ReviewEntry {
  if (/computer-use|claude-for-chrome/.test(name)) {
    return entry('D', 'Computer and browser integration requires an optional platform runtime and explicit enablement.')
  }
  if (/mcp-runtime|package:mcp-client/.test(name)) return entry('C', 'MCP integration is present but dynamic clients are not wired into ACP session creation.')
  if (/package:(?:@ant\/ink|@ant\/model-provider|builtin-tools|agent-tools)$/.test(name)) {
    return entry('E', 'Package is an internal vendor implementation component rather than a Harness integration surface.')
  }
  if (/package:workflow-engine/.test(name)) return entry('B', 'Workflow execution requires Harness lifecycle, persistence, and audit adaptation.')
  if (/package:acp-link/.test(name)) return entry('D', 'Remote ACP linking is an optional platform integration outside the core stdio boundary.')
  if (/plugin|hook|skill/i.test(name)) return entry('B', 'Extension state and errors require a Harness projection and audit surface.')
  return entry('D', 'Integration requires an optional platform runtime, credentials, callback, or external service.')
}

function classifyAcp(name: string): ReviewEntry {
  if (/image|mcp.*dynamic|local-command|agentInfo\.version/i.test(name)) return entry('C', 'Runtime and source probes confirm an ACP contract gap.')
  if (/initialize|newSession|loadSession|resumeSession|listSessions|closeSession|prompt|cancel/i.test(name)) {
    return entry('A', 'The operation is a native ACP session capability.')
  }
  return entry('B', 'The ACP capability needs normalization, persistence, or a Harness control surface.')
}

export function proposeClassification(
  capability: Pick<DiscoveredCapability, 'kind' | 'name' | 'id' | 'compiled'>,
): ReviewEntry {
  switch (capability.kind) {
    case 'tool':
      return classifyTool(capability.name)
    case 'feature':
      return classifyFeature(capability.name, capability.compiled)
    case 'command':
      if (capability.id.startsWith('command.prompt.')) {
        return entry('A', 'Prompt commands can be advertised and invoked through the ACP command surface.')
      }
      if (capability.id === 'command.local.compact') {
        return entry('B', 'Compact is non-interactive and requires a Harness ACP prompt adapter plus transcript projection.')
      }
      if (/theme|color|tui|stickers|keybindings|desktop|feedback/.test(capability.name)) {
        return entry('E', 'Terminal product-shell command is recorded but will not be reproduced by the Web Harness.')
      }
      return entry('C', 'ACP only advertises prompt commands; local and local-jsx commands are not invocable.')
    case 'agent':
      return entry('A', 'Agent definitions are loaded during ACP session creation and execute inside the vendor kernel.')
    case 'provider':
      return entry('D', 'Provider support is conditional on credentials, endpoint configuration, and a provider contract test.')
    case 'integration':
      return classifyIntegration(capability.name)
    case 'acp':
      return classifyAcp(capability.name)
    case 'runtime_flag':
      if (/TEST|DEBUG|TRACE|TELEMETRY|BENCHMARK/.test(capability.name)) {
        return entry('E', 'Diagnostic or test runtime condition is audited but is not a user capability.')
      }
      if (/PROVIDER|BEDROCK|VERTEX|FOUNDRY|OPENAI|GEMINI|GROK|LSP|REPL|WORKTREE|POWERSHELL/.test(capability.name)) {
        return entry('D', 'Runtime condition changes an optional provider or platform-dependent capability.')
      }
      return entry('B', 'Runtime condition changes the effective ACP session tool or behavior surface.')
    default: {
      const exhaustive: never = capability.kind
      throw new Error(`Unsupported capability kind: ${String(exhaustive)}`)
    }
  }
}

export function capabilityKey(kind: CapabilityKind, name: string): string {
  return `${kind}.${name}`
}
