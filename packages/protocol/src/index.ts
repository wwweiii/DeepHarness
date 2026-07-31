export type JsonPrimitive = string | number | boolean | null
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

export type SessionStatus =
  | 'queued'
  | 'starting'
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'interrupted'
  | 'recovery_required'
  | 'error'
  | 'closed'

export type SessionProcessState = 'queued' | 'starting' | 'running' | 'stopped' | 'exited'
export type SessionRecoveryStrategy = 'new' | 'resume' | 'load' | 'fork'
export type WorkspaceMode = 'shared' | 'worktree'
export type AgentActivityStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'interrupted'
  | 'quota_exceeded'
export type TaskActivityStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'deleted'
  | 'unknown'
export type TeamActivityStatus = 'active' | 'deleting' | 'deleted' | 'error'
export type ExtensionKind = 'skill' | 'plugin' | 'hook' | 'setting' | 'extra_tool'
export type ExtensionStatus = 'ready' | 'disabled' | 'error' | 'blocked' | 'unknown'
export type McpHealthStatus = 'configured' | 'disabled' | 'error' | 'blocked'
export type ContextCapabilityState =
  | 'supported'
  | 'kernel_managed'
  | 'conditional'
  | 'blocked'
  | 'disabled'
  | 'not_observable'

export type GoalStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'blocked'
  | 'stopped'
  | 'failed'
  | 'quota_exceeded'

export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'retry_waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'

export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'retry_waiting'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'

export type BackgroundJobType =
  | 'goal'
  | 'workflow'
  | 'cron'
  | 'sleep'
  | 'brief'
  | 'away_summary'
  | 'monitor'
  | 'remote_trigger'
  | 'agent_trigger'

export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'sleeping'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'orphaned'
  | 'quota_exceeded'

export type MisfirePolicy = 'run_once' | 'skip' | 'run_all'

export type HarnessEventType =
  | 'session.created'
  | 'session.status_changed'
  | 'session.process_changed'
  | 'session.recovery_changed'
  | 'session.closed'
  | 'turn.started'
  | 'user.message_created'
  | 'assistant.message_started'
  | 'assistant.text_delta'
  | 'assistant.reasoning_delta'
  | 'assistant.message_completed'
  | 'tool.call_started'
  | 'tool.call_updated'
  | 'tool.call_completed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'question.requested'
  | 'question.resolved'
  | 'plan.updated'
  | 'todo.updated'
  | 'prompt.queue_updated'
  | 'session.configuration_changed'
  | 'usage.updated'
  | 'turn.completed'
  | 'turn.failed'
  | 'session.interrupted'
  | 'worker.disconnected'
  | 'context.updated'
  | 'context.usage_updated'
  | 'context.compacted'
  | 'memory.observed'
  | 'workspace.lock_changed'
  | 'agent.started'
  | 'agent.updated'
  | 'agent.completed'
  | 'task.created'
  | 'task.updated'
  | 'task.output_delta'
  | 'team.updated'
  | 'team.message'
  | 'commands.updated'
  | 'extensions.updated'
  | 'extension.configuration_changed'
  | 'goal.created'
  | 'goal.updated'
  | 'goal.completed'
  | 'goal.blocked'
  | 'goal.continuation_started'
  | 'workflow.created'
  | 'workflow.run_started'
  | 'workflow.step_updated'
  | 'workflow.run_updated'
  | 'workflow.output_delta'
  | 'cron.scheduled'
  | 'cron.run_started'
  | 'cron.run_completed'
  | 'cron.run_missed'
  | 'cron.cancelled'
  | 'background.created'
  | 'background.updated'
  | 'background.output_delta'
  | 'background.attached'
  | 'background.stopped'
  | 'artifact.created'
  | 'artifact.updated'
  | 'artifact.rejected'
  | 'image.output'
  | 'lsp.diagnostics_updated'
  | 'lsp.location'
  | 'web.source_observed'
  | 'platform.updated'
  | 'integration.updated'

export const HARNESS_EVENT_TYPES: HarnessEventType[] = [
  'session.created',
  'session.status_changed',
  'session.process_changed',
  'session.recovery_changed',
  'session.closed',
  'turn.started',
  'user.message_created',
  'assistant.message_started',
  'assistant.text_delta',
  'assistant.reasoning_delta',
  'assistant.message_completed',
  'tool.call_started',
  'tool.call_updated',
  'tool.call_completed',
  'permission.requested',
  'permission.resolved',
  'question.requested',
  'question.resolved',
  'plan.updated',
  'todo.updated',
  'prompt.queue_updated',
  'session.configuration_changed',
  'usage.updated',
  'turn.completed',
  'turn.failed',
  'session.interrupted',
  'worker.disconnected',
  'context.updated',
  'context.usage_updated',
  'context.compacted',
  'memory.observed',
  'workspace.lock_changed',
  'agent.started',
  'agent.updated',
  'agent.completed',
  'task.created',
  'task.updated',
  'task.output_delta',
  'team.updated',
  'team.message',
  'commands.updated',
  'extensions.updated',
  'extension.configuration_changed',
  'goal.created',
  'goal.updated',
  'goal.completed',
  'goal.blocked',
  'goal.continuation_started',
  'workflow.created',
  'workflow.run_started',
  'workflow.step_updated',
  'workflow.run_updated',
  'workflow.output_delta',
  'cron.scheduled',
  'cron.run_started',
  'cron.run_completed',
  'cron.run_missed',
  'cron.cancelled',
  'background.created',
  'background.updated',
  'background.output_delta',
  'background.attached',
  'background.stopped',
  'artifact.created',
  'artifact.updated',
  'artifact.rejected',
  'image.output',
  'lsp.diagnostics_updated',
  'lsp.location',
  'web.source_observed',
  'platform.updated',
  'integration.updated',
]

export interface HarnessEvent {
  id: string
  sessionId: string
  turnId: string | null
  seq: number
  type: HarnessEventType
  timestamp: string
  payload: Record<string, JsonValue>
}

export type WorkerCommand =
  | {
      id: string
      type: 'start_session'
      sessionId: string
      payload: {
        workspaceId: string
        workspacePath: string
        workspaceMode: WorkspaceMode
        readOnly: boolean
        permissionMode: string
        modelId: string | null
        recoveryStrategy: SessionRecoveryStrategy
        agentSessionId: string | null
        sourceAgentSessionId: string | null
        createdVendorCommit: string | null
        lastVendorCommit: string | null
      }
    }
  | {
      id: string
      type: 'prompt'
      sessionId: string
      payload: { turnId: string; text: string }
    }
  | {
      id: string
      type: 'cancel'
      sessionId: string
      payload: { turnId: string | null }
    }
  | {
      id: string
      type: 'resolve_permission'
      sessionId: string
      payload: {
        permissionRequestId: string
        optionId: string
        answers?: Record<string, string>
      }
    }
  | {
      id: string
      type: 'set_mode'
      sessionId: string
      payload: { modeId: string }
    }
  | {
      id: string
      type: 'set_model'
      sessionId: string
      payload: { modelId: string }
    }
  | {
      id: string
      type: 'close_session'
      sessionId: string
      payload: { removeCleanWorktree: boolean }
    }
  | {
      id: string
      type: 'stop_agent'
      sessionId: string
      payload: {
        agentId: string
        vendorAgentId: string
        reason: string
      }
    }
  | {
      id: string
      type: 'stop_task'
      sessionId: string
      payload: {
        taskId: string
        vendorTaskId: string
        reason: string
      }
    }
  | {
      id: string
      type: 'refresh_extensions'
      sessionId: string
      payload: Record<string, never>
    }
  | {
      id: string
      type: 'set_extension_enabled'
      sessionId: string
      payload: {
        kind: 'plugin' | 'hook'
        name: string
        enabled: boolean
      }
    }
  | {
      id: string
      type: 'stop_background_job'
      sessionId: string
      payload: {
        jobId: string
        turnId: string | null
        reason: string
      }
    }

export type GatewayToWorkerMessage =
  | { kind: 'registered'; workerId: string }
  | { kind: 'command'; command: WorkerCommand }

export type WorkerToGatewayMessage =
  | {
      kind: 'register'
      worker: {
        id: string
        name: string
        maxConcurrency: number
        workspaceRoots: string[]
        version: string
        vendorCommit: string
        providerId: string
        credentialStatus: 'configured' | 'missing'
      }
    }
  | {
      kind: 'event'
      event: Omit<HarnessEvent, 'seq' | 'timestamp'> & { timestamp?: string }
    }
  | {
      kind: 'command_result'
      commandId: string
      sessionId: string
      ok: boolean
      error?: string
    }

export interface SessionRecord {
  id: string
  agentSessionId: string | null
  workspaceId: string
  workerId: string | null
  title: string
  status: SessionStatus
  permissionMode: string
  modelId: string | null
  providerId: string
  availableModes: SessionMode[]
  availableModels: SessionModel[]
  configOptions: SessionConfigOption[]
  promptQueueDepth: number
  activeTurnId: string | null
  processState: SessionProcessState
  recoveryStrategy: SessionRecoveryStrategy | null
  recoveryError: string | null
  contextState: Record<string, JsonValue>
  createdVendorCommit: string | null
  lastVendorCommit: string | null
  parentSessionId: string | null
  forkPointEventId: string | null
  worktreePath: string | null
  lastEventSeq: number
  createdAt: string
  updatedAt: string
}

export interface ContextUsageRecord {
  usedTokens: number | null
  sizeTokens: number | null
  percentage: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  updatedAt: string | null
}

export interface TranscriptContextRecord {
  recordCount: number
  userCheckpointCount: number
  compactCount: number
  lastUserMessageId: string | null
  latestCompactBoundaryId: string | null
  updatedAt: string | null
}

export interface MemoryObservationRecord {
  sessionId: string
  turnId: string | null
  toolCallId: string
  toolName: string
  sourceType: 'local_memory' | 'vault_http'
  sourceLabel: string
  operation: string
  status: string
  hit: boolean | null
  itemCount: number | null
  bytes: number | null
  truncated: boolean
  errorCode: string | null
  httpStatus: number | null
  contentRedacted: true
  updatedAt: string
}

export interface ContextCheckpointRecord {
  id: string
  sessionId: string
  turnId: string | null
  kind: 'compact'
  trigger: 'manual' | 'auto' | 'unknown'
  status: string
  boundaryId: string | null
  preTokens: number | null
  messagesSummarized: number | null
  source: string
  createdAt: string
}

export interface ContextCapabilityRecord {
  id: string
  name: string
  matrixClass: 'A' | 'B' | 'C' | 'D' | 'E'
  compiled: boolean
  enabled: boolean
  tested: boolean
  lastTestResult: 'passed' | 'expected_failure' | 'not_tested'
  state: ContextCapabilityState
  reason: string | null
}

export interface DataLifecycleBoundary {
  dataClass: 'memory' | 'transcript' | 'artifact' | 'database_event'
  sourceOfTruth: string
  controlPlaneContent: 'metadata_only' | 'full_event' | 'registry_only'
  backupScope: string
  deleteBoundary: string
}

export interface SessionContextSnapshot {
  sessionId: string
  usage: ContextUsageRecord | null
  transcript: TranscriptContextRecord | null
  memories: MemoryObservationRecord[]
  checkpoints: ContextCheckpointRecord[]
  capabilities: ContextCapabilityRecord[]
  operations: Record<string, JsonValue>
  compatibility: Record<string, JsonValue>
  lifecycle: DataLifecycleBoundary[]
}

export interface WorkspaceRecord {
  id: string
  name: string
  workerId: string | null
  containerPath: string
  mode: WorkspaceMode
  readOnly: boolean
  metadata: Record<string, JsonValue>
  lockedBySessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface EventPage {
  events: HarnessEvent[]
  nextBeforeSeq: number | null
}

export interface SessionMode {
  id: string
  name: string
  description?: string
}

export interface SessionModel {
  modelId: string
  name: string
  description?: string
}

export interface SessionConfigOption {
  id: string
  name: string
  type: string
  currentValue?: string
  options?: JsonValue[]
}

export interface PermissionOption {
  optionId: string
  kind: string
  name: string
}

export interface AgentActivityRecord {
  id: string
  sessionId: string
  turnId: string | null
  vendorAgentId: string | null
  toolCallId: string
  parentAgentId: string | null
  parentToolCallId: string | null
  agentType: string
  name: string | null
  description: string
  status: AgentActivityStatus
  runInBackground: boolean
  permissionMode: string
  workspacePath: string | null
  totalTokens: number | null
  totalDurationMs: number | null
  totalToolUseCount: number | null
  output: JsonValue
  metadata: Record<string, JsonValue>
  startedAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TaskActivityRecord {
  id: string
  sessionId: string
  turnId: string | null
  vendorTaskId: string
  parentAgentId: string | null
  subject: string
  description: string
  status: TaskActivityStatus
  owner: string | null
  blockedBy: string[]
  blocks: string[]
  taskType: string | null
  output: JsonValue
  metadata: Record<string, JsonValue>
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface TeamPeerRecord {
  id: string
  sessionId: string
  teamId: string
  agentId: string | null
  name: string
  role: string
  status: string
  address: string | null
  cwd: string | null
  pid: number | null
  metadata: Record<string, JsonValue>
  updatedAt: string
}

export interface TeamActivityRecord {
  id: string
  sessionId: string
  name: string
  description: string
  status: TeamActivityStatus
  leadAgentId: string | null
  metadata: Record<string, JsonValue>
  peers: TeamPeerRecord[]
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface TeamMessageRecord {
  id: string
  sessionId: string
  teamId: string | null
  sender: string
  recipient: string
  messageType: string
  content: JsonValue
  summary: string | null
  deliveryStatus: string
  metadata: Record<string, JsonValue>
  createdAt: string
}

export interface AgentDefinitionSummary {
  id: string
  name: string
  enabled: boolean
  invocable: boolean | null
  tested: boolean
  matrixClass: string
  conditions: JsonValue[]
  knownGap: string | null
}

export interface AvailableCommand {
  name: string
  description: string
  inputHint: string | null
  source: 'acp' | 'manifest'
  commandType: 'prompt' | 'local' | 'local-jsx'
  callable: boolean
  blockedReason: string | null
  updatedAt: string
}

export interface ExtensionEntry {
  id: string
  kind: ExtensionKind
  name: string
  source: 'user' | 'project' | 'local' | 'vendor' | 'plugin'
  path: string | null
  enabled: boolean
  status: ExtensionStatus
  condition: string | null
  error: string | null
  metadata: Record<string, JsonValue>
}

export interface McpResourceSummary {
  uri: string
  name: string
  description: string | null
  mimeType: string | null
}

export interface McpServerStatus {
  name: string
  source: 'user' | 'project' | 'local' | 'plugin'
  transport: string
  endpoint: string | null
  enabled: boolean
  health: McpHealthStatus
  authStatus: 'not_required' | 'configured' | 'required' | 'blocked' | 'unknown'
  supportsTools: boolean | null
  supportsResources: boolean | null
  resources: McpResourceSummary[]
  error: string | null
  blockedReason: string | null
  metadata: Record<string, JsonValue>
}

export interface ExtensionAuditRecord {
  id: string
  sessionId: string
  kind: 'plugin' | 'hook'
  name: string
  action: 'enabled' | 'disabled'
  restartRequired: boolean
  createdAt: string
}

export interface SessionExtensionSnapshot {
  revision: number
  commands: AvailableCommand[]
  extensions: ExtensionEntry[]
  mcpServers: McpServerStatus[]
  audits: ExtensionAuditRecord[]
  sourceErrors: string[]
  updatedAt: string | null
}

export interface ActivityLimits {
  maxActiveAgents: number
  maxAgentDepth: number
  maxTeamPeers: number
  maxAgentTokens: number
  activeAgents: number
  observedAgentTokens: number
}

export interface SessionActivitySnapshot {
  agents: AgentActivityRecord[]
  tasks: TaskActivityRecord[]
  teams: TeamActivityRecord[]
  messages: TeamMessageRecord[]
  definitions: AgentDefinitionSummary[]
  limits: ActivityLimits | null
}

export interface ProviderProfile {
  id: string
  name: string
  vendorProvider: string
  activationEnvironment: Record<string, string>
  credentialEnvironment: string[]
  credentialAlternatives: string[][]
  credentialStatus: 'configured' | 'missing'
  active: boolean
  automatedTest: 'fake_passed' | 'config_validated' | 'not_tested'
  smokeCommand: string
}

export interface GoalRecord {
  id: string
  sessionId: string
  vendorGoalId: string | null
  objective: string
  status: GoalStatus
  tokenBudget: number | null
  continuationLimit: number
  continuationCount: number
  completionEvidence: JsonValue
  blockedAudit: JsonValue
  permissionMode: string
  workspaceId: string
  nextContinuationAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface WorkflowDefinitionRecord {
  id: string
  sessionId: string | null
  name: string
  description: string
  sourcePath: string | null
  sourceHash: string | null
  enabled: boolean
  steps: JsonValue[]
  metadata: Record<string, JsonValue>
  createdAt: string
  updatedAt: string
}

export interface WorkflowStepRecord {
  id: string
  runId: string
  stepIndex: number
  name: string
  prompt: string
  status: WorkflowStepStatus
  attempt: number
  maxAttempts: number
  input: JsonValue
  output: JsonValue
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface WorkflowRunRecord {
  id: string
  definitionId: string
  sessionId: string
  status: WorkflowRunStatus
  currentStepIndex: number
  input: JsonValue
  output: JsonValue
  retryCount: number
  maxRetries: number
  cancelRequested: boolean
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  steps: WorkflowStepRecord[]
}

export interface CronScheduleRecord {
  id: string
  name: string
  ownerSessionId: string
  jobId: string
  expression: string
  timezone: string
  misfirePolicy: MisfirePolicy
  maxCatchUp: number
  status: 'active' | 'paused' | 'cancelled'
  nextRunAt: string | null
  lastScheduledAt: string | null
  lastStartedAt: string | null
  lastCompletedAt: string | null
  metadata: Record<string, JsonValue>
  createdAt: string
  updatedAt: string
}

export interface BackgroundJobRecord {
  id: string
  type: BackgroundJobType
  status: BackgroundJobStatus
  ownerSessionId: string | null
  workerId: string | null
  workspaceId: string | null
  cronScheduleId: string | null
  goalId: string | null
  workflowRunId: string | null
  title: string
  input: JsonValue
  output: JsonValue
  logCursor: number
  continuationCount: number
  maxContinuations: number
  tokenBudget: number | null
  spentTokens: number
  nextRunAt: string | null
  lastHeartbeatAt: string | null
  orphanedAt: string | null
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface BackgroundJobSnapshot {
  job: BackgroundJobRecord
  logs: HarnessEvent[]
  attached: boolean
}

export type ArtifactStatus = 'ready' | 'rejected' | 'expired'

export interface ArtifactRecord {
  id: string
  sessionId: string
  turnId: string | null
  toolCallId: string | null
  kind: 'file' | 'image' | 'notebook' | 'review' | 'unknown'
  name: string
  relativePath: string | null
  workspaceRelativePath: string | null
  storagePath: string | null
  mimeType: string
  sizeBytes: number
  sha256: string | null
  contentHash: string | null
  source: 'workspace' | 'acp' | 'inline'
  status: ArtifactStatus
  previewStatus: 'available' | 'unavailable' | 'rejected' | 'pending'
  previewable: boolean
  downloadable: boolean
  contentAvailable: boolean
  rejectionReason: string | null
  metadata: Record<string, JsonValue>
  createdAt: string
  updatedAt: string
}

export interface ArtifactSnapshot {
  artifact: ArtifactRecord
  content: string | null
}

export type LspSeverity = 'error' | 'warning' | 'information' | 'hint' | 'unknown'

export interface LspDiagnosticRecord {
  id: string
  sessionId: string
  turnId: string | null
  toolCallId: string | null
  uri: string
  path: string | null
  line: number | null
  column: number | null
  endLine: number | null
  endColumn: number | null
  severity: LspSeverity
  message: string
  code: string | null
  source: string | null
  related: JsonValue[]
  createdAt: string
}

export interface LspLocationRecord {
  id: string
  sessionId: string
  turnId: string | null
  toolCallId: string | null
  operation: 'definition' | 'references' | 'implementation' | 'type_definition' | 'unknown'
  uri: string
  path: string | null
  line: number | null
  column: number | null
  endLine: number | null
  endColumn: number | null
  preview: string | null
  metadata: Record<string, JsonValue>
  createdAt: string
}

export interface WebSourceRecord {
  id: string
  sessionId: string
  turnId: string | null
  toolCallId: string | null
  toolName: 'WebFetchTool' | 'WebSearchTool' | 'WebBrowserTool' | 'unknown'
  title: string
  url: string
  snippet: string | null
  sourceType: 'search' | 'fetch' | 'browser' | 'unknown'
  position: number | null
  metadata: Record<string, JsonValue>
  createdAt: string
}

export type PlatformIntegrationKind =
  | 'lsp'
  | 'browser'
  | 'terminal_capture'
  | 'powershell'
  | 'ssh'
  | 'bridge'
  | 'voice'
  | 'notifications'
  | 'scm'

export interface PlatformIntegrationRecord {
  id: string
  kind: PlatformIntegrationKind
  profile: string
  status: 'available' | 'disabled' | 'blocked' | 'not_tested' | 'error'
  enabled: boolean
  conditions: string[]
  capabilities: string[]
  evidence: string | null
  updatedAt: string
}

export interface GoalSnapshot {
  goal: GoalRecord
  job: BackgroundJobRecord | null
  events: HarnessEvent[]
}

export interface WorkflowSnapshot {
  definition: WorkflowDefinitionRecord
  runs: WorkflowRunRecord[]
}

export interface CapabilityView {
  vendorCommit: string
  generatedAt: string
  summary: Record<string, JsonValue>
  capabilities: Array<Record<string, JsonValue>>
  knownGaps: JsonValue[]
  providers: ProviderProfile[]
}

export interface SessionSnapshot {
  session: SessionRecord | null
  events: HarnessEvent[]
  workerOnline: boolean
}
