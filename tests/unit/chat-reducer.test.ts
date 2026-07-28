import { describe, expect, test } from 'bun:test'
import type { HarnessEvent } from '@deepharness/protocol'
import { projectHarnessEvents } from '../../apps/web/src/features/chat/runtime/reducer.ts'

function event(
  seq: number,
  type: HarnessEvent['type'],
  payload: HarnessEvent['payload'] = {},
): HarnessEvent {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    sessionId: '00000000-0000-4000-8000-000000000100',
    turnId: seq <= 1 ? null : '00000000-0000-4000-8000-000000000200',
    seq,
    type,
    timestamp: `2026-07-28T00:00:${String(seq).padStart(2, '0')}.000Z`,
    payload,
  }
}

describe('Harness event projection', () => {
  test('merges text and reasoning deltas while ignoring replay duplicates', () => {
    const events = [
      event(1, 'session.created', { status: 'queued' }),
      event(2, 'user.message_created', { text: 'Hello' }),
      event(3, 'turn.started'),
      event(4, 'assistant.message_started'),
      event(5, 'assistant.reasoning_delta', { text: 'Check ' }),
      event(6, 'assistant.reasoning_delta', { text: 'context.' }),
      event(7, 'assistant.text_delta', { text: 'STREAM ' }),
      event(8, 'assistant.text_delta', { text: 'OK' }),
      event(9, 'assistant.message_completed', { stopReason: 'end_turn' }),
      event(10, 'turn.completed', { stopReason: 'end_turn' }),
    ]
    const projection = projectHarnessEvents([...events, events[7]!])
    expect(projection.status).toBe('idle')
    expect(projection.messages).toHaveLength(2)
    expect(projection.messages[1]?.content).toEqual([
      { type: 'reasoning', text: 'Check context.' },
      { type: 'text', text: 'STREAM OK' },
    ])
    expect(projection.messages[1]?.status).toEqual({ type: 'complete', reason: 'stop' })
  })

  test('keeps cancellation and failures as message status instead of fake text', () => {
    const cancelled = projectHarnessEvents([
      event(2, 'user.message_created', { text: '[slow]' }),
      event(3, 'turn.started'),
      event(4, 'assistant.message_started'),
      event(5, 'assistant.message_completed', { stopReason: 'cancelled' }),
      event(6, 'session.interrupted', { reason: 'user_cancelled' }),
      event(7, 'turn.completed', { stopReason: 'cancelled' }),
    ])
    expect(cancelled.messages[1]?.status).toEqual({ type: 'incomplete', reason: 'cancelled' })
    expect(cancelled.messages[1]?.content).toEqual([])

    const failed = projectHarnessEvents([
      event(2, 'user.message_created', { text: 'Fail' }),
      event(3, 'turn.started'),
      event(4, 'turn.failed', { message: 'provider unavailable' }),
    ])
    expect(failed.error).toBe('provider unavailable')
    expect(failed.messages[1]?.status).toMatchObject({ type: 'incomplete', reason: 'error' })
    expect(failed.messages[1]?.content).toEqual([])
  })
})
