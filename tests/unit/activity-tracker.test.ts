import { describe, expect, test } from 'bun:test'
import type { HarnessEvent, JsonValue } from '@deepharness/protocol'
import { ActivityTracker } from '../../apps/worker/src/activity.ts'
import type { PersistedActivityState } from '../../apps/worker/src/activityState.ts'

type Emitted = {
  type: HarnessEvent['type']
  payload: Record<string, JsonValue>
  turnId: string | null
}

function tracker(overrides: Partial<{
  permissionMode: string
  workspacePath: string
  maxActiveAgents: number
  maxAgentDepth: number
  maxTeamPeers: number
  maxAgentTokens: number
}> = {}) {
  const events: Emitted[] = []
  const violations: string[] = []
  const activity = new ActivityTracker({
    permissionMode: overrides.permissionMode ?? 'acceptEdits',
    workspacePath: overrides.workspacePath ?? '/workspace/source',
    maxActiveAgents: overrides.maxActiveAgents ?? 4,
    maxAgentDepth: overrides.maxAgentDepth ?? 3,
    maxTeamPeers: overrides.maxTeamPeers ?? 4,
    maxAgentTokens: overrides.maxAgentTokens ?? 200_000,
    emit: (type, payload, turnId) => events.push({ type, payload, turnId }),
    onPolicyViolation: reason => violations.push(reason),
  })
  return { activity, events, violations }
}

function agentTool(
  activity: ActivityTracker,
  toolCallId: string,
  parentToolUseId: string | null,
  rawInput: Record<string, JsonValue> = {},
): void {
  activity.observeTool({
    toolCallId,
    toolName: 'Agent',
    status: 'in_progress',
    rawInput: {
      subagent_type: 'general-purpose',
      description: toolCallId,
      ...rawInput,
    },
    parentToolUseId,
    turnId: '00000000-0000-4000-8000-000000000001',
  })
}

describe('ActivityTracker', () => {
  test('hydrates Agent fields and rechecks policy when ACP sends input in a later update', () => {
    const hydrated = tracker()
    hydrated.activity.observeTool({
      toolCallId: 'deferred-input',
      toolName: 'Agent',
      status: 'pending',
      rawInput: {},
      parentToolUseId: null,
      turnId: null,
    })
    hydrated.activity.observeTool({
      toolCallId: 'deferred-input',
      toolName: 'Agent',
      status: 'in_progress',
      rawInput: {
        subagent_type: 'Explore',
        description: 'Input arrived after tool start',
      },
      parentToolUseId: null,
      turnId: null,
    })
    expect(hydrated.events.findLast(event => event.type === 'agent.updated')?.payload)
      .toMatchObject({
        id: 'deferred-input',
        agentType: 'Explore',
        description: 'Input arrived after tool start',
      })

    const restricted = tracker({ permissionMode: 'default' })
    restricted.activity.observeTool({
      toolCallId: 'late-custom-agent',
      toolName: 'Agent',
      status: 'pending',
      rawInput: {},
      parentToolUseId: null,
      turnId: null,
    })
    restricted.activity.observeTool({
      toolCallId: 'late-custom-agent',
      toolName: 'Agent',
      status: 'in_progress',
      rawInput: { subagent_type: 'custom-writer' },
      parentToolUseId: null,
      turnId: null,
    })
    expect(restricted.violations).toContain('SUBAGENT_PERMISSION_EXPANSION:default->default')
  })

  test('routes nested chunks and tools to the exact parent agent', () => {
    const { activity, events } = tracker()
    agentTool(activity, 'agent-root', null)
    agentTool(activity, 'agent-child', 'agent-root')

    expect(activity.observeChunk('agent-child', 'text', 'child output')).toBe(true)
    expect(activity.observeChunk(null, 'text', 'parent output')).toBe(false)
    const route = activity.observeTool({
      toolCallId: 'nested-read',
      toolName: 'Read',
      status: 'in_progress',
      rawInput: { file_path: '/workspace/source/README.md' },
      parentToolUseId: 'agent-child',
      turnId: '00000000-0000-4000-8000-000000000001',
    })

    expect(route.parentAgentId).toBe('agent-child')
    expect(events.find(event => event.type === 'agent.started' && event.payload.id === 'agent-child')?.payload)
      .toMatchObject({ parentAgentId: 'agent-root' })
    expect(events.findLast(event => event.type === 'agent.updated' && event.payload.id === 'agent-child')?.payload)
      .toMatchObject({ output: 'child output' })
    expect(events.findLast(event => event.type === 'agent.updated' && event.payload.id === 'agent-child')?.payload.metadata)
      .toMatchObject({ lastToolCall: { toolName: 'Read' } })
  })

  test('propagates Agent stops to descendants and restores truthful state on control failure', () => {
    const failed = tracker()
    agentTool(failed.activity, 'failed-root', null)
    agentTool(failed.activity, 'failed-child', 'failed-root')
    expect(failed.activity.requestAgentStop('failed-root')?.status).toBe('stopping')
    expect(failed.events.filter(event => event.type === 'agent.updated').slice(-2)
      .map(event => event.payload)).toEqual([
      expect.objectContaining({ id: 'failed-root', status: 'stopping' }),
      expect.objectContaining({ id: 'failed-child', status: 'stopping' }),
    ])
    failed.activity.controlFailed('agent', 'failed-root', 'TaskStop was rejected')
    expect(failed.events.filter(event => event.type === 'agent.updated').slice(-2)
      .map(event => event.payload)).toEqual([
      expect.objectContaining({
        id: 'failed-root',
        status: 'running',
        metadata: expect.objectContaining({ controlError: 'TaskStop was rejected' }),
      }),
      expect.objectContaining({
        id: 'failed-child',
        status: 'running',
        metadata: expect.objectContaining({ controlError: 'TaskStop was rejected' }),
      }),
    ])
    expect(failed.events.some(event => event.type === 'agent.completed')).toBe(false)

    failed.activity.observeTool({
      toolCallId: 'task-create',
      toolName: 'TaskCreate',
      status: 'completed',
      rawInput: { subject: 'Pending task' },
      rawOutput: { task: { id: 'task-one' } },
      parentToolUseId: null,
      turnId: null,
    })
    expect(failed.activity.requestTaskStop('task-one')?.status).toBe('stopping')
    failed.activity.controlFailed('task', 'task-one', 'TaskStop was rejected')
    expect(failed.events.findLast(event => event.type === 'task.updated')?.payload)
      .toMatchObject({
        id: 'task-one',
        status: 'pending',
        metadata: { controlError: 'TaskStop was rejected' },
      })

    const completed = tracker()
    agentTool(completed.activity, 'root', null)
    agentTool(completed.activity, 'child', 'root')
    completed.activity.observeTool({
      toolCallId: 'root',
      toolName: 'Agent',
      status: 'completed',
      rawInput: { run_in_background: true },
      rawOutput: { status: 'async_launched', agent_id: 'vendor-root' },
      parentToolUseId: null,
      turnId: null,
    })
    completed.activity.observeTool({
      toolCallId: 'child',
      toolName: 'Agent',
      status: 'completed',
      rawInput: { run_in_background: true },
      rawOutput: { status: 'async_launched', agent_id: 'vendor-child' },
      parentToolUseId: 'root',
      turnId: null,
    })
    completed.activity.requestAgentStop('root')
    completed.activity.observeTool({
      toolCallId: 'task-stop',
      toolName: 'TaskStop',
      status: 'completed',
      rawInput: { task_id: 'vendor-root' },
      rawOutput: { message: 'Stopped', task_type: 'local_agent' },
      parentToolUseId: null,
      turnId: null,
    })
    expect(completed.events.filter(event => event.type === 'agent.completed').slice(-2)
      .map(event => event.payload)).toEqual([
      expect.objectContaining({ id: 'root', status: 'stopped' }),
      expect.objectContaining({ id: 'child', status: 'stopped' }),
    ])
  })

  test('enforces depth, concurrency, workspace, token, peer, and permission limits', () => {
    const depth = tracker({ maxAgentDepth: 1 })
    agentTool(depth.activity, 'depth-root', null)
    agentTool(depth.activity, 'depth-child', 'depth-root')
    expect(depth.violations).toContain('SUBAGENT_DEPTH_LIMIT:1')

    const concurrency = tracker({ maxActiveAgents: 1 })
    agentTool(concurrency.activity, 'active-a', null)
    agentTool(concurrency.activity, 'active-b', null)
    expect(concurrency.violations).toContain('SUBAGENT_CONCURRENCY_LIMIT:1')

    const workspace = tracker()
    agentTool(workspace.activity, 'outside', null, { cwd: '/outside' })
    expect(workspace.violations).toContain('SUBAGENT_WORKSPACE_BOUNDARY:/outside')

    const permission = tracker({ permissionMode: 'default' })
    agentTool(permission.activity, 'custom', null, { subagent_type: 'custom-writer' })
    expect(permission.violations).toContain('SUBAGENT_PERMISSION_EXPANSION:default->default')

    const requestedMode = tracker({ permissionMode: 'default' })
    agentTool(requestedMode.activity, 'bypass', null, { mode: 'bypassPermissions' })
    expect(requestedMode.violations)
      .toContain('SUBAGENT_PERMISSION_EXPANSION:default->bypassPermissions')

    const tokens = tracker({ maxAgentTokens: 10 })
    agentTool(tokens.activity, 'token-a', null)
    tokens.activity.observeTool({
      toolCallId: 'token-a',
      toolName: 'Agent',
      status: 'completed',
      rawInput: {},
      rawOutput: { agentId: 'vendor-a', totalTokens: 10 },
      parentToolUseId: null,
      turnId: null,
    })
    agentTool(tokens.activity, 'token-b', null)
    expect(tokens.violations).toContain('SUBAGENT_TOKEN_LIMIT:10')

    const peers = tracker({ maxTeamPeers: 1 })
    peers.activity.reconcile({
      toolResults: [],
      agentNotifications: [],
      tasks: [],
      teams: [{
        id: 'quota-team',
        name: 'quota-team',
        description: '',
        leadAgentId: 'lead',
        createdAt: '2026-07-28T00:00:00.000Z',
        peers: [{
          id: 'lead',
          agentId: 'lead',
          name: 'team-lead',
          role: 'lead',
          status: 'active',
          address: 'team-lead@quota-team',
          cwd: '/workspace/source',
          pid: null,
          metadata: {},
        }],
      }],
      scannedTaskLists: ['quota-team'],
      teamScanComplete: true,
    }, null)
    agentTool(peers.activity, 'peer-overflow', null, { name: 'builder' })
    expect(peers.violations).toContain('TEAM_PEER_LIMIT:1')
  })

  test('coordinator pressure never projects more active agents than its quota', () => {
    const { activity, violations } = tracker({ maxActiveAgents: 3 })
    for (let index = 0; index < 50; index += 1) {
      agentTool(activity, `pressure-${index}`, null)
    }
    expect(activity.limits.activeAgents).toBe(3)
    expect(violations.filter(reason => reason === 'SUBAGENT_CONCURRENCY_LIMIT:3')).toHaveLength(47)
  })

  test('closes active Agents, process-backed Tasks, and Team peers on session close', () => {
    const { activity, events } = tracker()
    agentTool(activity, 'background-agent', null, {
      run_in_background: true,
      name: 'builder',
    })
    activity.observeTool({
      toolCallId: 'background-agent',
      toolName: 'Agent',
      status: 'completed',
      rawInput: { run_in_background: true, name: 'builder' },
      rawOutput: {
        status: 'teammate_spawned',
        agent_id: 'vendor-builder',
        team_name: 'phase-four',
        name: 'builder',
      },
      parentToolUseId: null,
      turnId: null,
    })
    activity.observeTool({
      toolCallId: 'task-output',
      toolName: 'TaskOutput',
      status: 'completed',
      rawInput: { task_id: 'vendor-builder' },
      rawOutput: {
        task: { status: 'in_progress', task_type: 'local_agent', output: 'working' },
      },
      parentToolUseId: null,
      turnId: null,
    })
    activity.observeTool({
      toolCallId: 'task-create',
      toolName: 'TaskCreate',
      status: 'completed',
      rawInput: { subject: 'Keep pending task' },
      rawOutput: { task: { id: 'pending-task' } },
      parentToolUseId: null,
      turnId: null,
    })

    activity.closeActive('session_closed')

    expect(activity.hasActiveAgents).toBe(false)
    expect(activity.limits.activeAgents).toBe(0)
    expect(events.findLast(event => event.type === 'agent.completed')?.payload)
      .toMatchObject({ id: 'background-agent', status: 'stopped' })
    expect(events.findLast(event => event.type === 'task.updated'
      && event.payload.id === 'vendor-builder')?.payload)
      .toMatchObject({ status: 'stopped', metadata: { stopReason: 'session_closed' } })
    expect(events.findLast(event => event.type.startsWith('task.')
      && event.payload.id === 'pending-task')?.payload.status).toBe('pending')
    expect(events.findLast(event => event.type === 'team.updated')?.payload.peers)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'vendor-builder', status: 'stopped' }),
      ]))
  })

  test('reconciles transcript results and vendor Task/Team snapshots idempotently', () => {
    const { activity, events } = tracker()
    agentTool(activity, 'async-agent', null, { run_in_background: true, name: 'builder' })
    const state: PersistedActivityState = {
      toolResults: [{
        toolCallId: 'async-agent',
        failed: false,
        output: {
          status: 'async_launched',
          agentId: 'agent-vendor-1',
          description: 'Build',
        },
      }],
      agentNotifications: [{
        agentId: 'agent-vendor-1',
        toolCallId: 'async-agent',
        status: 'completed',
        summary: 'Background Agent completed',
        result: 'BACKGROUND_AGENT_OK',
        totalTokens: 21,
        totalDurationMs: 58,
        totalToolUseCount: 0,
      }],
      tasks: [{
        taskListId: 'team-one',
        id: '1',
        subject: 'Implement',
        description: 'Implement phase four',
        status: 'in_progress',
        owner: 'builder',
        blockedBy: [],
        blocks: [],
        metadata: {},
      }],
      teams: [{
        id: 'team-one',
        name: 'team-one',
        description: 'Delivery team',
        leadAgentId: 'lead-1',
        createdAt: '2026-07-28T00:00:00.000Z',
        peers: [{
          id: 'agent-vendor-1',
          agentId: 'agent-vendor-1',
          name: 'builder',
          role: 'worker',
          status: 'active',
          address: 'builder@team-one',
          cwd: '/workspace/source',
          pid: null,
          metadata: {},
        }],
      }],
      scannedTaskLists: ['team-one'],
      teamScanComplete: true,
    }

    expect(activity.reconcile(state, null)).toEqual(new Set(['async-agent']))
    expect(activity.reconcile(state, null)).toEqual(new Set())
    expect(activity.agentForId('agent-vendor-1')).toMatchObject({
      id: 'async-agent',
      status: 'completed',
      vendorAgentId: 'agent-vendor-1',
      totalTokens: 21,
      output: expect.objectContaining({ result: 'BACKGROUND_AGENT_OK' }),
    })
    expect(events.find(event => event.type === 'task.created')?.payload)
      .toMatchObject({ vendorTaskId: '1', status: 'in_progress' })
    expect(events.findLast(event => event.type === 'team.updated')?.payload)
      .toMatchObject({ id: 'team-one', leadAgentId: 'lead-1' })

    activity.reconcile({
      ...state,
      toolResults: [],
      tasks: [],
      teams: [],
    }, null)
    expect(events.findLast(event => event.type === 'task.updated')?.payload.status).toBe('deleted')
    expect(events.findLast(event => event.type === 'team.updated')?.payload.status).toBe('deleted')
  })
})
