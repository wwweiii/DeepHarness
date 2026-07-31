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

  test('projects image output as an assistant-ui data URL image part', () => {
    const projection = projectHarnessEvents([
      event(2, 'user.message_created', { text: 'Create an image' }),
      event(3, 'turn.started'),
      event(4, 'assistant.message_started'),
      event(5, 'image.output', {
        artifactId: '00000000-0000-4000-8000-000000000800',
        mimeType: 'image/png',
        contentBase64: 'iVBORw0KGgo=',
      }),
      event(6, 'assistant.message_completed', { stopReason: 'end_turn' }),
      event(7, 'turn.completed', { stopReason: 'end_turn' }),
    ])

    expect(projection.messages[1]?.content).toEqual([
      { type: 'image', image: 'data:image/png;base64,iVBORw0KGgo=' },
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

  test('merges Context usage, compact metadata, and redacted Memory observations', () => {
    const projection = projectHarnessEvents([
      event(1, 'context.updated', {
        operations: { load: true, rewind: { state: 'blocked' } },
        transcript: { recordCount: 2, compactCount: 0 },
      }),
      event(2, 'context.usage_updated', {
        usedTokens: 40,
        sizeTokens: 100,
        percentage: 40,
      }),
      event(3, 'context.updated', {
        transcript: { recordCount: 3, compactCount: 1 },
      }),
      event(4, 'context.compacted', {
        status: 'completed',
        boundaryId: 'compact-1',
        transcript: { recordCount: 3, compactCount: 1 },
      }),
      event(5, 'memory.observed', {
        toolCallId: 'memory-1',
        sourceType: 'local_memory',
        sourceLabel: 'project/preferences',
        status: 'completed',
        hit: true,
        contentRedacted: true,
      }),
      event(6, 'memory.observed', {
        toolCallId: 'memory-1',
        sourceType: 'local_memory',
        sourceLabel: 'project/preferences',
        status: 'failed',
        errorCode: 'not_found',
        contentRedacted: true,
      }),
    ])

    expect(projection.contextState).toMatchObject({
      operations: { load: true, rewind: { state: 'blocked' } },
      usage: { usedTokens: 40, sizeTokens: 100, percentage: 40 },
      transcript: { recordCount: 3, compactCount: 1 },
      compact: { status: 'completed', boundaryId: 'compact-1' },
    })
    expect((projection.contextState?.memories as Array<Record<string, unknown>>)).toEqual([
      expect.objectContaining({
        toolCallId: 'memory-1',
        status: 'failed',
        errorCode: 'not_found',
        contentRedacted: true,
      }),
    ])
  })

  test('preserves explicit recovery diagnostics from worker events', () => {
    const projection = projectHarnessEvents([
      event(1, 'session.recovery_changed', {
        status: 'recovery_required',
        strategy: 'load',
        message: 'TRANSCRIPT_CORRUPT:agent-session:line:1',
      }),
      event(2, 'session.status_changed', {
        status: 'recovery_required',
        message: 'TRANSCRIPT_CORRUPT:agent-session:line:1',
        processState: 'stopped',
      }),
    ])

    expect(projection.status).toBe('recovery_required')
    expect(projection.processState).toBe('stopped')
    expect(projection.recoveryStrategy).toBe('load')
    expect(projection.recoveryError).toBe('TRANSCRIPT_CORRUPT:agent-session:line:1')
  })

  test('projects nested Agent, Task, and Team activity without leaking child tools into parent output', () => {
    const events = [
      event(2, 'user.message_created', { text: 'Coordinate work' }),
      event(3, 'turn.started'),
      event(4, 'tool.call_started', {
        toolCallId: 'agent-root',
        toolName: 'Agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      event(5, 'agent.started', {
        id: 'agent-root',
        toolCallId: 'agent-root',
        agentType: 'general-purpose',
        status: 'running',
        permissionMode: 'default',
        metadata: { activityLimits: {
          maxActiveAgents: 4,
          maxAgentDepth: 3,
          maxTeamPeers: 4,
          maxAgentTokens: 1000,
          activeAgents: 1,
          observedAgentTokens: 0,
        } },
      }),
      event(6, 'agent.started', {
        id: 'agent-child',
        toolCallId: 'agent-child',
        parentAgentId: 'agent-root',
        parentToolCallId: 'agent-root',
        agentType: 'Explore',
        status: 'running',
        permissionMode: 'default',
      }),
      event(7, 'tool.call_started', {
        toolCallId: 'nested-read',
        toolName: 'Read',
        parentAgentId: 'agent-child',
        rawInput: { file_path: '/workspace/source/README.md' },
      }),
      event(8, 'agent.updated', {
        id: 'agent-child',
        toolCallId: 'agent-child',
        parentAgentId: 'agent-root',
        status: 'running',
        output: 'nested output',
      }),
      event(9, 'task.created', {
        id: '1',
        vendorTaskId: '1',
        subject: 'Implement',
        status: 'pending',
      }),
      event(10, 'task.updated', {
        id: '1',
        vendorTaskId: '1',
        owner: 'builder',
      }),
      event(11, 'team.updated', {
        id: 'phase-four',
        name: 'phase-four',
        status: 'active',
        peers: [{ name: 'builder', status: 'active' }],
      }),
      event(12, 'team.message', {
        teamId: 'phase-four',
        sender: 'team-lead',
        recipient: 'builder',
        messageType: 'message',
        content: 'Run verification',
        deliveryStatus: 'delivered',
      }),
    ]
    const projection = projectHarnessEvents(events)
    const replay = projectHarnessEvents(events)

    expect(projection.messages[1]?.content).toHaveLength(1)
    expect((projection.messages[1]?.content[0] as { toolCallId?: string }).toolCallId).toBe('agent-root')
    expect(JSON.stringify(projection.messages)).not.toContain('nested-read')
    expect(projection.agents.find(agent => agent.id === 'agent-child')).toMatchObject({
      parentAgentId: 'agent-root',
      output: 'nested output',
    })
    expect(projection.tasks[0]).toMatchObject({
      status: 'pending',
      owner: 'builder',
    })
    expect(projection.teams[0]?.peers[0]?.id).toBe('builder')
    expect(replay.teams[0]?.peers[0]?.id).toBe(projection.teams[0]?.peers[0]?.id)
    expect(projection.teamMessages[0]).toMatchObject({
      sender: 'team-lead',
      recipient: 'builder',
      deliveryStatus: 'delivered',
    })
    expect(projection.activityLimits).toMatchObject({ activeAgents: 1, maxAgentDepth: 3 })
  })

  test('projects session close as terminal activity without completing ordinary pending Tasks', () => {
    const closedAt = '2026-07-28T08:00:00.000Z'
    const projection = projectHarnessEvents([
      event(1, 'agent.started', {
        id: 'agent-running',
        toolCallId: 'agent-running',
        agentType: 'Explore',
        status: 'running',
        permissionMode: 'default',
        metadata: { activityLimits: {
          maxActiveAgents: 4,
          maxAgentDepth: 3,
          maxTeamPeers: 4,
          maxAgentTokens: 1000,
          activeAgents: 1,
          observedAgentTokens: 0,
        } },
      }),
      event(2, 'task.created', {
        id: 'background-task',
        vendorTaskId: 'background-task',
        subject: 'Background process',
        status: 'in_progress',
        taskType: 'local_agent',
      }),
      event(3, 'task.created', {
        id: 'ordinary-task',
        vendorTaskId: 'ordinary-task',
        subject: 'Ordinary pending work',
        status: 'pending',
      }),
      event(4, 'team.updated', {
        id: 'phase-four',
        name: 'phase-four',
        status: 'active',
        peers: [{ id: 'builder', name: 'builder', status: 'active' }],
      }),
      { ...event(5, 'session.closed', { status: 'closed' }), timestamp: closedAt },
    ])

    expect(projection.status).toBe('closed')
    expect(projection.agents[0]).toMatchObject({
      status: 'stopped',
      completedAt: closedAt,
      metadata: { stopReason: 'session_closed' },
    })
    expect(projection.tasks.find(task => task.id === 'background-task')).toMatchObject({
      status: 'stopped',
      completedAt: closedAt,
    })
    expect(projection.tasks.find(task => task.id === 'ordinary-task')?.status).toBe('pending')
    expect(projection.teams[0]?.peers[0]).toMatchObject({
      status: 'stopped',
      metadata: { stopReason: 'session_closed' },
    })
    expect(projection.activityLimits?.activeAgents).toBe(0)
  })
})
