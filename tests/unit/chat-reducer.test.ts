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

  test('preserves unknown tool input, partial output, final output, and errors', () => {
    const projection = projectHarnessEvents([
      event(2, 'user.message_created', { text: 'Use a new tool' }),
      event(3, 'turn.started'),
      event(4, 'tool.call_started', {
        toolCallId: 'tool-unknown',
        toolName: 'FutureTool',
        rawInput: { nested: { value: '<script>not executable</script>' } },
        status: 'pending',
      }),
      event(5, 'tool.call_updated', {
        toolCallId: 'tool-unknown',
        toolName: 'FutureTool',
        rawOutput: { chunk: 'partial' },
        status: 'in_progress',
      }),
      event(6, 'tool.call_completed', {
        toolCallId: 'tool-unknown',
        toolName: 'FutureTool',
        rawOutput: { message: 'final failure' },
        status: 'failed',
      }),
    ])
    const part = projection.messages[1]?.content[0] as any
    expect(part).toMatchObject({
      type: 'tool-call',
      toolCallId: 'tool-unknown',
      toolName: 'FutureTool',
      args: { nested: { value: '<script>not executable</script>' } },
      result: { message: 'final failure' },
      isError: true,
    })
    expect(part.argsText).toContain('<script>not executable</script>')
  })

  test('replays approvals, denials, expiration, and pending questions', () => {
    const requested = event(5, 'permission.requested', {
      permissionRequestId: '00000000-0000-4000-8000-000000000501',
      toolCallId: 'tool-permission',
      toolName: 'Bash',
      input: { command: 'printf ok' },
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    })
    const approved = projectHarnessEvents([
      event(2, 'turn.started'),
      requested,
      requested,
      event(6, 'permission.resolved', {
        permissionRequestId: '00000000-0000-4000-8000-000000000501',
        toolCallId: 'tool-permission',
        toolName: 'Bash',
        status: 'approved',
        optionId: 'allow',
      }),
    ])
    expect((approved.messages[0]?.content[0] as any).approval).toMatchObject({
      approved: true,
      optionId: 'allow',
    })
    expect(approved.eventCount).toBe(3)

    const expired = projectHarnessEvents([
      event(2, 'turn.started'),
      requested,
      event(6, 'permission.resolved', {
        permissionRequestId: '00000000-0000-4000-8000-000000000501',
        toolCallId: 'tool-permission',
        toolName: 'Bash',
        status: 'expired',
        optionId: 'reject',
      }),
    ])
    expect((expired.messages[0]?.content[0] as any).approval).toMatchObject({
      approved: false,
      resolution: 'expired',
    })

    const question = projectHarnessEvents([
      event(2, 'turn.started'),
      event(3, 'permission.requested', {
        permissionRequestId: '00000000-0000-4000-8000-000000000502',
        toolCallId: 'tool-question',
        toolName: 'AskUserQuestion',
        input: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }] },
        options: [{ optionId: 'allow', kind: 'allow_once', name: 'Answer' }],
      }),
      event(4, 'question.requested', {
        permissionRequestId: '00000000-0000-4000-8000-000000000502',
        toolCallId: 'tool-question',
        toolName: 'AskUserQuestion',
      }),
    ])
    const questionPart = question.messages[0]?.content[0] as any
    expect(questionPart.toolName).toBe('AskUserQuestion')
    expect(questionPart.args.questions[0].question).toBe('Continue?')
    expect(questionPart.approval.approved).toBeUndefined()
    expect(question.messages[0]?.status).toEqual({ type: 'requires-action', reason: 'tool-calls' })
  })

  test('projects Plan/Todo, usage, queue depth, and ACP configuration', () => {
    const projection = projectHarnessEvents([
      event(1, 'session.status_changed', {
        status: 'idle',
        permissionMode: 'default',
        modelId: 'model-a',
        availableModes: [{ id: 'default', name: 'Default' }],
        availableModels: [{ modelId: 'model-a', name: 'Model A' }],
      }),
      event(2, 'turn.started'),
      event(3, 'tool.call_started', {
        toolCallId: 'tool-todo',
        toolName: 'TodoWrite',
        rawInput: { todos: [{ content: 'Verify', status: 'in_progress' }] },
      }),
      event(4, 'plan.updated', {
        entries: [{ content: 'Verify', status: 'in_progress' }],
      }),
      event(5, 'todo.updated', {
        entries: [{ content: 'Verify', status: 'completed' }],
      }),
      event(6, 'usage.updated', {
        inputTokens: 17,
        outputTokens: 4,
        totalTokens: 21,
      }),
      event(7, 'prompt.queue_updated', { depth: 2 }),
      event(8, 'session.configuration_changed', {
        permissionMode: 'acceptEdits',
        modelId: 'model-b',
      }),
    ])
    expect(projection.plan).toEqual([{ content: 'Verify', status: 'in_progress' }])
    expect(projection.usage).toMatchObject({ totalTokens: 21 })
    expect(projection.promptQueueDepth).toBe(2)
    expect(projection.permissionMode).toBe('acceptEdits')
    expect(projection.modelId).toBe('model-b')
    expect(projection.availableModes).toEqual([{ id: 'default', name: 'Default' }])
    expect(projection.messages[0]?.content).toHaveLength(2)
  })
})
