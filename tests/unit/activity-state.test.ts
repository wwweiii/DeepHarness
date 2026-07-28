import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readPersistedActivityState } from '../../apps/worker/src/activityState.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('readPersistedActivityState', () => {
  test('recovers terminal tool results and the active team task list', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'deepharness-activity-'))
    cleanup.push(root)
    const configDir = path.join(root, '.claude')
    const sessionId = '00000000-0000-4000-8000-000000000401'
    const transcriptPath = path.join(root, `${sessionId}.jsonl`)
    await mkdir(path.join(configDir, 'tasks', sessionId), { recursive: true })
    await mkdir(path.join(configDir, 'tasks', 'phase-four'), { recursive: true })
    await mkdir(path.join(configDir, 'teams', 'phase-four'), { recursive: true })
    await mkdir(path.join(configDir, 'teams', 'phase-four', 'inboxes'), { recursive: true })
    await writeFile(path.join(configDir, 'tasks', sessionId, '99.json'), JSON.stringify({
      id: '99',
      subject: 'Superseded standalone task',
      description: '',
      status: 'pending',
      blockedBy: [],
      blocks: [],
    }), 'utf8')
    await writeFile(path.join(configDir, 'tasks', 'phase-four', '1.json'), JSON.stringify({
      id: '1',
      subject: 'Team task',
      description: 'Persisted source of truth',
      status: 'in_progress',
      owner: 'builder',
      blockedBy: ['2'],
      blocks: [],
      metadata: { priority: 'high' },
    }), 'utf8')
    await writeFile(path.join(configDir, 'teams', 'phase-four', 'config.json'), JSON.stringify({
      name: 'phase-four',
      description: 'Phase four team',
      createdAt: 1_785_193_200_000,
      leadAgentId: 'lead-1',
      leadSessionId: sessionId,
      members: [{
        agentId: 'lead-1',
        name: 'team-lead',
        agentType: 'lead',
        joinedAt: 1_785_193_200_000,
        tmuxPaneId: '',
        cwd: '/workspace/source',
        subscriptions: [],
      }, {
        agentId: 'agent-1',
        name: 'builder',
        agentType: 'worker',
        joinedAt: 1_785_193_200_000,
        tmuxPaneId: '',
        cwd: '/workspace/source',
        subscriptions: ['code'],
        backendType: 'in-process',
        isActive: false,
      }],
    }), 'utf8')
    await writeFile(
      path.join(configDir, 'teams', 'phase-four', 'inboxes', 'team-lead.json'),
      JSON.stringify([{
        from: 'builder',
        text: JSON.stringify({
          type: 'shutdown_approved',
          requestId: 'shutdown-builder-1',
          from: 'builder',
          timestamp: '2026-07-28T00:00:00.000Z',
          backendType: 'in-process',
          paneId: 'in-process',
        }),
        timestamp: '2026-07-28T00:00:00.000Z',
        read: false,
      }]),
      'utf8',
    )
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'agent-tool-1',
          content: [{ type: 'text', text: 'complete' }],
        }],
      },
      toolUseResult: {
        status: 'async_launched',
        agentId: 'agent-1',
      },
    })}\n${JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '<task-notification>\n<task-id>agent-1</task-id>\n<tool-use-id>agent-tool-1</tool-use-id>\n<status>completed</status>\n<summary>Agent completed</summary>\n<result>VERIFICATION_AGENT_OK</result>\n<usage><total_tokens>17</total_tokens><tool_uses>0</tool_uses><duration_ms>58</duration_ms></usage>\n</task-notification>',
    })}\n${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'missing-tool-1',
          content: '{"result":null,"tool_name":"TaskCreate"}',
        }],
      },
      toolUseResult: { result: null, tool_name: 'TaskCreate' },
    })}\n${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: 'Tool "TaskCreate" not found. Use SearchExtraTools to discover available tools.',
      },
    })}\n`, 'utf8')

    const state = await readPersistedActivityState(sessionId, { configDir, transcriptPath })

    expect(state.scannedTaskLists).toEqual(['phase-four'])
    expect(state.tasks).toEqual([expect.objectContaining({
      id: '1',
      status: 'in_progress',
      owner: 'builder',
      blockedBy: ['2'],
    })])
    expect(state.toolResults).toEqual([
      {
        toolCallId: 'agent-tool-1',
        output: { status: 'async_launched', agentId: 'agent-1' },
        failed: false,
      },
      {
        toolCallId: 'missing-tool-1',
        output: 'Tool "TaskCreate" not found. Use SearchExtraTools to discover available tools.',
        failed: true,
      },
    ])
    expect(state.agentNotifications).toEqual([{
      agentId: 'agent-1',
      toolCallId: 'agent-tool-1',
      status: 'completed',
      summary: 'Agent completed',
      result: 'VERIFICATION_AGENT_OK',
      totalTokens: 17,
      totalDurationMs: 58,
      totalToolUseCount: 0,
    }])
    expect(state.teams[0]).toMatchObject({
      name: 'phase-four',
      leadAgentId: 'lead-1',
      peers: [
        { name: 'team-lead', role: 'lead', address: 'team-lead@phase-four' },
        {
          name: 'builder',
          role: 'worker',
          status: 'idle',
          address: 'builder@phase-four',
          metadata: {
            shutdownApproval: {
              requestId: 'shutdown-builder-1',
              timestamp: '2026-07-28T00:00:00.000Z',
              backendType: 'in-process',
              paneId: 'in-process',
            },
          },
        },
      ],
    })
  })
})
