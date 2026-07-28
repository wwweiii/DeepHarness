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
  | 'error'
  | 'closed'

export type HarnessEventType =
  | 'session.created'
  | 'session.status_changed'
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

export const HARNESS_EVENT_TYPES: HarnessEventType[] = [
  'session.created',
  'session.status_changed',
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
        workspacePath: string
        permissionMode: string
        modelId: string | null
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

export type GatewayToWorkerMessage =
  | { kind: 'registered'; workerId: string }
  | { kind: 'command'; command: WorkerCommand }

export type WorkerToGatewayMessage =
  | {
      kind: 'register'
      worker: {
        id: string
        name: string
        maxConcurrency: 1
        workspacePath: string
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
  lastEventSeq: number
  createdAt: string
  updatedAt: string
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
