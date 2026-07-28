import type {
  HarnessEvent,
  PermissionOption,
  SessionMode,
  SessionModel,
  SessionProcessState,
  SessionRecoveryStrategy,
  SessionStatus,
} from '@deepharness/protocol'
import type { ThreadMessageLike } from '@assistant-ui/react'

type MessagePart = Exclude<ThreadMessageLike['content'], string>[number]
type MutableToolPart = {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  argsText: string
  result?: unknown
  isError?: boolean
  approval?: {
    id: string
    approved?: boolean
    optionId?: string
    options?: Array<{ id: string; kind: string; label?: string }>
    resolution?: 'cancelled' | 'expired'
  }
}

export interface HarnessProjection {
  messages: ThreadMessageLike[]
  status: SessionStatus
  error: string | null
  usage: Record<string, unknown> | null
  plan: Array<Record<string, unknown>>
  permissionMode: string | null
  modelId: string | null
  promptQueueDepth: number
  processState: SessionProcessState
  recoveryStrategy: SessionRecoveryStrategy | null
  recoveryError: string | null
  contextState: Record<string, unknown> | null
  eventCount: number
  availableModes: SessionMode[]
  availableModels: SessionModel[]
}

type MutableMessage = {
  id: string
  role: 'user' | 'assistant'
  content: Array<MessagePart | MutableToolPart>
  status?: ThreadMessageLike['status']
  createdAt: Date
}

function getAssistant(messages: MutableMessage[], turnId: string): MutableMessage {
  const id = `assistant-${turnId}`
  const existing = messages.find(message => message.id === id)
  if (existing) return existing
  const message: MutableMessage = {
    id,
    role: 'assistant',
    content: [],
    status: { type: 'running' },
    createdAt: new Date(),
  }
  messages.push(message)
  return message
}

function appendPart(
  message: MutableMessage,
  type: 'text' | 'reasoning',
  text: string,
): void {
  const last = message.content.at(-1)
  if (last?.type === type && 'text' in last) {
    message.content[message.content.length - 1] = { type, text: `${last.text}${text}` }
  } else message.content.push({ type, text })
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function toolPart(
  message: MutableMessage,
  toolCallId: string,
  toolName: string,
): MutableToolPart {
  const existing = message.content.find(
    (part): part is MutableToolPart => part.type === 'tool-call' && part.toolCallId === toolCallId,
  )
  if (existing) {
    if (existing.toolName === 'UnknownTool') existing.toolName = toolName
    return existing
  }
  const created: MutableToolPart = {
    type: 'tool-call',
    toolCallId,
    toolName,
    args: {},
    argsText: '{}',
  }
  message.content.push(created)
  return created
}

function applyToolEvent(message: MutableMessage, event: HarnessEvent): void {
  const toolCallId = String(event.payload.toolCallId ?? event.id)
  const toolName = String(event.payload.toolName ?? 'UnknownTool')
  const part = toolPart(message, toolCallId, toolName)
  if (event.payload.rawInput !== undefined) {
    part.args = objectValue(event.payload.rawInput)
    part.argsText = JSON.stringify(part.args)
  }
  if (event.payload.rawOutput !== undefined) part.result = event.payload.rawOutput
  if (event.type === 'tool.call_completed') {
    part.isError = event.payload.status === 'failed'
    if (part.result === undefined && event.payload.content !== undefined) {
      part.result = event.payload.content
    }
  }
}

export function projectHarnessEvents(events: HarnessEvent[]): HarnessProjection {
  const messages: MutableMessage[] = []
  const seen = new Set<string>()
  let status: SessionStatus = 'queued'
  let error: string | null = null
  let usage: Record<string, unknown> | null = null
  let plan: Array<Record<string, unknown>> = []
  let permissionMode: string | null = null
  let modelId: string | null = null
  let promptQueueDepth = 0
  let processState: SessionProcessState = 'stopped'
  let recoveryStrategy: SessionRecoveryStrategy | null = null
  let recoveryError: string | null = null
  let contextState: Record<string, unknown> | null = null
  let availableModes: SessionMode[] = []
  let availableModels: SessionModel[] = []

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const turnId = event.turnId

    if (event.type === 'session.created') status = 'queued'
    if (event.type === 'session.status_changed' && typeof event.payload.status === 'string') {
      status = event.payload.status as SessionStatus
      if (status === 'error' && typeof event.payload.message === 'string') error = event.payload.message
      if (status === 'recovery_required' && typeof event.payload.message === 'string') {
        recoveryError = event.payload.message
      }
      if (typeof event.payload.permissionMode === 'string') permissionMode = event.payload.permissionMode
      if (typeof event.payload.modelId === 'string') modelId = event.payload.modelId
      if (Array.isArray(event.payload.availableModes)) availableModes = event.payload.availableModes as unknown as SessionMode[]
      if (Array.isArray(event.payload.availableModels)) availableModels = event.payload.availableModels as unknown as SessionModel[]
      if (typeof event.payload.processState === 'string') processState = event.payload.processState as SessionProcessState
      if (typeof event.payload.recoveryStrategy === 'string') {
        recoveryStrategy = event.payload.recoveryStrategy as SessionRecoveryStrategy
      }
    }
    if (event.type === 'session.process_changed' && typeof event.payload.processState === 'string') {
      processState = event.payload.processState as SessionProcessState
    }
    if (event.type === 'session.recovery_changed') {
      if (typeof event.payload.strategy === 'string') recoveryStrategy = event.payload.strategy as SessionRecoveryStrategy
      recoveryError = event.payload.status === 'recovery_required'
        ? String(event.payload.loadError ?? event.payload.resumeError ?? event.payload.message ?? 'Recovery failed')
        : null
    }
    if (event.type === 'context.updated') contextState = event.payload
    if (event.type === 'worker.disconnected') processState = 'stopped'
    if (event.type === 'session.closed') {
      status = 'closed'
      processState = 'stopped'
    }
    if (event.type === 'session.configuration_changed') {
      if (typeof event.payload.permissionMode === 'string') permissionMode = event.payload.permissionMode
      if (typeof event.payload.modelId === 'string') modelId = event.payload.modelId
    }
    if (event.type === 'prompt.queue_updated' && typeof event.payload.depth === 'number') {
      promptQueueDepth = event.payload.depth
    }
    if (event.type === 'turn.started') status = 'running'
    if (event.type === 'turn.completed') status = 'idle'
    if (event.type === 'turn.failed') {
      status = 'error'
      error = typeof event.payload.message === 'string'
        ? event.payload.message
        : 'The Agent turn failed.'
      if (turnId) {
        getAssistant(messages, turnId).status = {
          type: 'incomplete',
          reason: 'error',
          error: { message: error },
        }
      }
    }
    if (event.type === 'session.interrupted') {
      status = event.payload.reason === 'user_cancelled' ? 'cancelling' : 'interrupted'
    }
    if (event.type === 'usage.updated') usage = event.payload

    if (event.type === 'user.message_created' && turnId) {
      messages.push({
        id: `user-${turnId}`,
        role: 'user',
        content: [{ type: 'text', text: typeof event.payload.text === 'string' ? event.payload.text : '' }],
        createdAt: new Date(event.timestamp),
      })
    }
    if (event.type === 'assistant.message_started' && turnId) {
      const message = getAssistant(messages, turnId)
      message.createdAt = new Date(event.timestamp)
      message.status = { type: 'running' }
    }
    if (event.type === 'assistant.text_delta' && turnId) {
      const text = event.payload.text
      if (typeof text === 'string') appendPart(getAssistant(messages, turnId), 'text', text)
    }
    if (event.type === 'assistant.reasoning_delta' && turnId) {
      const text = event.payload.text
      if (typeof text === 'string') appendPart(getAssistant(messages, turnId), 'reasoning', text)
    }
    if (event.type.startsWith('tool.call_') && turnId) {
      applyToolEvent(getAssistant(messages, turnId), event)
    }
    if (event.type === 'permission.requested' && turnId) {
      const message = getAssistant(messages, turnId)
      const part = toolPart(
        message,
        String(event.payload.toolCallId ?? event.id),
        String(event.payload.toolName ?? 'UnknownTool'),
      )
      if (Object.keys(part.args).length === 0) part.args = objectValue(event.payload.input)
      part.argsText = JSON.stringify(part.args)
      part.approval = {
        id: String(event.payload.permissionRequestId),
        options: Array.isArray(event.payload.options)
          ? (event.payload.options as unknown as PermissionOption[]).map(option => ({
              id: option.optionId,
              kind: option.kind,
              label: option.name,
            }))
          : [],
      }
      message.status = { type: 'requires-action', reason: 'tool-calls' }
    }
    if (event.type === 'permission.resolved' && turnId) {
      const message = getAssistant(messages, turnId)
      const part = toolPart(
        message,
        String(event.payload.toolCallId ?? event.id),
        String(event.payload.toolName ?? 'UnknownTool'),
      )
      const resolvedStatus = String(event.payload.status ?? 'denied')
      part.approval = {
        ...(part.approval ?? { id: String(event.payload.permissionRequestId) }),
        approved: resolvedStatus === 'approved',
        optionId: String(event.payload.optionId ?? ''),
        ...(resolvedStatus === 'expired' ? { resolution: 'expired' as const } : {}),
      }
      message.status = { type: 'running' }
    }
    if (event.type === 'plan.updated' && turnId) {
      plan = Array.isArray(event.payload.entries)
        ? event.payload.entries.map(objectValue)
        : []
      const part = toolPart(getAssistant(messages, turnId), `plan-${turnId}`, 'TodoWrite')
      part.args = { todos: plan }
      part.argsText = JSON.stringify(part.args)
      part.result = { entries: plan }
    }
    if (event.type === 'assistant.message_completed' && turnId) {
      const stopReason = event.payload.stopReason
      getAssistant(messages, turnId).status = stopReason === 'cancelled'
        ? { type: 'incomplete', reason: 'cancelled' }
        : { type: 'complete', reason: 'stop' }
    }
  }

  return {
    messages: messages as ThreadMessageLike[],
    status,
    error,
    usage,
    plan,
    permissionMode,
    modelId,
    promptQueueDepth,
    processState,
    recoveryStrategy,
    recoveryError,
    contextState,
    eventCount: seen.size,
    availableModes,
    availableModels,
  }
}
