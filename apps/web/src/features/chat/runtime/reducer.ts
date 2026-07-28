import type {
  HarnessEvent,
  SessionStatus,
} from '@deepharness/protocol'
import type { ThreadMessageLike } from '@assistant-ui/react'

export interface HarnessProjection {
  messages: ThreadMessageLike[]
  status: SessionStatus
  error: string | null
  usage: Record<string, unknown> | null
}

type MutableMessage = {
  id: string
  role: 'user' | 'assistant'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
  >
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
  if (last?.type === type) last.text += text
  else message.content.push({ type, text })
}

export function projectHarnessEvents(events: HarnessEvent[]): HarnessProjection {
  const messages: MutableMessage[] = []
  const seen = new Set<string>()
  let status: SessionStatus = 'queued'
  let error: string | null = null
  let usage: Record<string, unknown> | null = null

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const turnId = event.turnId

    if (event.type === 'session.created') status = 'queued'
    if (event.type === 'session.status_changed' && typeof event.payload.status === 'string') {
      status = event.payload.status as SessionStatus
      if (status === 'error' && typeof event.payload.message === 'string') {
        error = event.payload.message
      }
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
        content: [{
          type: 'text',
          text: typeof event.payload.text === 'string' ? event.payload.text : '',
        }],
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
  }
}
