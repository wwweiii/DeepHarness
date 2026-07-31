import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()
const phase7CapabilityIds = [
  'feature.GOAL', 'tool.GoalTool', 'command.local-jsx.goal',
  'feature.WORKFLOW_SCRIPTS', 'tool.WorkflowTool', 'command.local-jsx.workflows',
  'tool.CronCreateTool', 'tool.CronDeleteTool', 'tool.CronListTool', 'tool.ScheduleCronTool', 'feature.KAIROS',
  'feature.KAIROS_BRIEF', 'feature.AWAY_SUMMARY', 'tool.BriefTool', 'command.local-jsx.brief',
  'feature.BG_SESSIONS', 'tool.SleepTool', 'tool.MonitorTool', 'feature.MONITOR_TOOL', 'command.local-jsx.monitor',
  'tool.RemoteTriggerTool', 'feature.AGENT_TRIGGERS', 'feature.AGENT_TRIGGERS_REMOTE', 'command.local-jsx.triggers',
]

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 7 Goal, Workflow, Cron, and background capability contract', () => {
  test('keeps every phase 7 workflow evidence entry tied to a discovered capability', async () => {
    const [evidence, manifest] = await Promise.all([
      json('config/harness-capability-evidence.json'),
      json('artifacts/capabilities/vendor-capability-manifest.json'),
    ])
    const entries = evidence.capabilities.filter((entry: any) => entry.phase === 7)
    expect(entries.map((entry: any) => entry.id).sort()).toEqual([...phase7CapabilityIds].sort())
    for (const entry of entries) {
      expect(manifest.capabilities.some((capability: any) => capability.id === entry.id)).toBe(true)
      expect(entry.evidence_path.includes('phase-7')
        || entry.evidence_path.includes('workflows.ts')
        || entry.evidence_path.includes('scheduler.test.ts')
        || entry.evidence_path.includes('AutomationPanel.tsx')).toBe(true)
    }
  })

  test('defines durable automation tables and protocol events without a vendor import', async () => {
    const [migration, protocol, automation, scheduler, supervisor] = await Promise.all([
      readFile(`${root}/packages/database/migrations/0007_phase_7.sql`, 'utf8'),
      readFile(`${root}/packages/protocol/src/index.ts`, 'utf8'),
      readFile(`${root}/apps/gateway/src/automation.ts`, 'utf8'),
      readFile(`${root}/apps/gateway/src/scheduler.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/supervisor.ts`, 'utf8'),
    ])
    for (const table of ['goals', 'workflow_definitions', 'workflow_runs', 'workflow_steps', 'cron_schedules', 'background_jobs', 'background_job_logs', 'background_job_intents']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const event of ['goal.created', 'goal.completed', 'goal.blocked', 'workflow.step_updated', 'cron.run_missed', 'background.attached', 'background.stopped']) {
      expect(protocol).toContain(`'${event}'`)
    }
    expect(automation).toContain('completion_evidence')
    expect(automation).toContain('blocked_audit')
    expect(automation).toContain('recoverOrphans')
    expect(scheduler).toContain('missedCronOccurrences')
    expect(scheduler).toContain('cronPendingOccurrences')
    expect(supervisor).not.toMatch(/vendor\/claude-code/)
  })

  test('keeps Agent triggers as an explicit ACP blocker', async () => {
    const [manifest, gaps] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
    ])
    const trigger = manifest.capabilities.find((entry: any) => entry.id === 'command.local-jsx.triggers')
    expect(trigger).toMatchObject({ advertised_by_acp: false, tested: false, invocable: null })
    expect(gaps.known_gaps.some((gap: any) => gap.id === 'gap.acp.agent-triggers' && gap.status === 'expected_failure')).toBe(true)
    expect(gaps.known_gaps.some((gap: any) => gap.id === 'gap.platform.remote-trigger' && gap.status === 'expected_failure')).toBe(true)
  })
})
