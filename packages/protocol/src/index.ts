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
  activeTurnId: string | null
  lastEventSeq: number
  createdAt: string
  updatedAt: string
}

export interface SessionSnapshot {
  session: SessionRecord | null
  events: HarnessEvent[]
  workerOnline: boolean
}
