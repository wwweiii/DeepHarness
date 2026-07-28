import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
} from '@assistant-ui/react'
import type { HarnessEvent } from '@deepharness/protocol'
import { useEffect, type PropsWithChildren } from 'react'
import { requestId } from '../../../lib/requestId.ts'
import { useSessionEvents } from './useSessionEvents.ts'

interface HarnessRuntimeProviderProps extends PropsWithChildren {
  sessionId: string
  initialEvents: HarnessEvent[]
  onProjection: ReturnType<typeof useSessionEvents> extends infer Result
    ? (result: Result) => void
    : never
}

function messageText(message: AppendMessage): string {
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': requestId(),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error ?? `Request failed with status ${response.status}`)
  }
}

export function HarnessRuntimeProvider({
  sessionId,
  initialEvents,
  onProjection,
  children,
}: HarnessRuntimeProviderProps) {
  const store = useSessionEvents(sessionId, initialEvents)
  useEffect(() => {
    onProjection(store)
  }, [onProjection, store])
  const runtime = useExternalStoreRuntime({
    messages: store.projection.messages,
    isRunning: store.projection.status === 'running' || store.projection.status === 'cancelling',
    isDisabled: !store.connected || ['queued', 'starting', 'error', 'recovery_required', 'closed'].includes(store.projection.status),
    isSendDisabled: store.projection.status === 'cancelling',
    convertMessage: message => message,
    onNew: async message => {
      const text = messageText(message)
      if (text) await post(`/api/sessions/${sessionId}/prompts`, { text })
    },
    onCancel: async () => post(`/api/sessions/${sessionId}/cancel`, {}),
    onRespondToToolApproval: async ({ approvalId, approved, optionId }) => {
      await post(`/api/sessions/${sessionId}/permissions/${approvalId}/resolve`, {
        optionId: optionId ?? (approved ? 'allow' : 'reject'),
      })
    },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
