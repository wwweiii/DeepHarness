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
  | 'workspace.lock_changed'

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
  'workspace.lock_changed',
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
  parentSessionId: string | null
  forkPointEventId: string | null
  worktreePath: string | null
  lastEventSeq: number
  createdAt: string
  updatedAt: string
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
