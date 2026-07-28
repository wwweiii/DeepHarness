import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

const expectedAgentIds = [
  'agent.Explore',
  'agent.Plan',
  'agent.custom-agent-definitions',
  'agent.general-purpose',
  'agent.verification',
  'feature.BUILTIN_EXPLORE_PLAN_AGENTS',
  'feature.VERIFICATION_AGENT',
  'tool.AgentTool',
]

const expectedActivityIds = [
  'runtime_flag.CLAUDE_CODE_ENABLE_TASKS',
  'tool.SendMessageTool',
  'tool.TaskCreateTool',
  'tool.TaskGetTool',
  'tool.TaskListTool',
  'tool.TaskOutputTool',
  'tool.TaskStopTool',
  'tool.TaskUpdateTool',
  'tool.TeamCreateTool',
  'tool.TeamDeleteTool',
]

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 4 Agent, Task, Team, and Coordinator capability contract', () => {
  test('publishes only runtime-backed Agent capabilities as passed', async () => {
    const [manifest, evidence] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
    ])
    const entries = evidence.capabilities.filter((entry: any) =>
      entry.phase === 4 && entry.workflow === 'agent')
    expect(entries.map((entry: any) => entry.id).sort()).toEqual(expectedAgentIds.sort())

    for (const entry of entries) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      expect(capability).toBeDefined()
      expect(capability.tested).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.ui_supported).toBe(true)
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'tests/integration/phase-4-stack.test.ts',
          evidenceType: 'runtime',
        }),
      ]))
    }
  })

  test('publishes runtime-backed Task and Team capabilities as passed', async () => {
    const [manifest, evidence] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
    ])
    const entries = evidence.capabilities.filter((entry: any) =>
      entry.phase === 4 && ['task', 'team'].includes(entry.workflow))
    expect(entries.map((entry: any) => entry.id).sort()).toEqual(expectedActivityIds.sort())

    for (const entry of entries) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      expect(capability).toBeDefined()
      expect(capability.tested).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.ui_supported).toBe(true)
      expect(capability.invocable).toBe(entry.invocable === undefined ? true : entry.invocable)
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'tests/integration/phase-4-stack.test.ts',
          evidenceType: 'runtime',
        }),
      ]))
    }
  })

  test('keeps ACP and build blockers explicit instead of claiming coordinator parity', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const gaps = new Map(manifest.known_gaps.map((gap: any) => [gap.id, gap]))
    for (const id of [
      'gap.acp.subagent-prelaunch-policy',
      'gap.acp.coordinator-mode-activation',
      'gap.acp.agent-triggers',
      'gap.build.list-peers-uds-inbox',
      'gap.vendor.in-process-team-shutdown',
    ]) {
      const gap = gaps.get(id) as Record<string, any> | undefined
      expect(gap).toMatchObject({ status: 'expected_failure' })
      expect(gap?.evidence.length).toBeGreaterThan(0)
      expect(gap?.upstream_strategy).toBeTruthy()
    }

    const coordinator = manifest.capabilities.find((item: any) =>
      item.id === 'feature.COORDINATOR_MODE')
    expect(coordinator).toMatchObject({ compiled: true, tested: false })
    const triggers = manifest.capabilities.find((item: any) =>
      item.id === 'command.local-jsx.triggers')
    expect(triggers).toMatchObject({ tested: false, invocable: null })
    const listPeers = manifest.capabilities.find((item: any) => item.id === 'tool.ListPeersTool')
    expect(listPeers).toMatchObject({ enabled: false, tested: false })
    const teamDelete = manifest.capabilities.find((item: any) => item.id === 'tool.TeamDeleteTool')
    expect(teamDelete).toMatchObject({ tested: true, last_test_result: 'passed' })
    expect(teamDelete.known_gap).toContain('gap.vendor.in-process-team-shutdown')
  })

  test('publishes the Agent capability transitions in the gated diff', async () => {
    const [diff, lock] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-diff.json'),
      json('config/vendor-lock.json'),
    ])
    expect(diff.previous_vendor_commit).toBe('34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d')
    expect(diff.current_vendor_commit).toBe(lock.commit)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    const changedIds = diff.changed.map((entry: any) => entry.id)
    expect(changedIds).toEqual(expect.arrayContaining([
      ...expectedAgentIds,
      ...expectedActivityIds,
    ]))
    expect(diff.regressions).toEqual([])
    expect(diff.gate).toEqual({
      unreviewed_additions: [],
      unapproved_regressions: [],
    })
  })

  test('keeps vendor source immutable and the runtime boundary ACP-only', async () => {
    const [supervisor, activityState] = await Promise.all([
      readFile(`${root}/apps/worker/src/supervisor.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/activityState.ts`, 'utf8'),
    ])
    expect(supervisor).not.toMatch(/from ['"].*vendor\/claude-code/)
    expect(supervisor).toContain("from './acp/client.ts'")
    expect(activityState).toContain("record.type !== 'queue-operation'")
    expect(activityState).toContain("content.includes('<task-notification>')")
  })
})
