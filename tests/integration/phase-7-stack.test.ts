import { expect, test } from 'bun:test'
import type {
  BackgroundJobRecord,
  BackgroundJobSnapshot,
  CronScheduleRecord,
  GoalRecord,
  SessionRecord,
  SessionSnapshot,
  WorkflowDefinitionRecord,
  WorkflowRunRecord,
  WorkflowSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const workerUrl = process.env.WORKER_TEST_URL
const databaseUrl = process.env.DATABASE_URL
const stackTest = baseUrl && workerUrl && databaseUrl ? test : test.skip

async function request<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  return { response, body }
}

async function post<T>(path: string, body: Record<string, unknown> = {}, key: string = crypto.randomUUID()): Promise<T> {
  const result = await request<T>(path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body),
  })
  if (!result.response.ok) throw new Error(result.body.error ?? `HTTP ${result.response.status}`)
  return result.body
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function sessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
  return (await request<SessionSnapshot>(`/api/sessions/${sessionId}`)).body
}

async function goalSnapshot(goalId: string): Promise<{ goal: GoalRecord; job: BackgroundJobRecord | null }> {
  return (await request<{ goal: GoalRecord; job: BackgroundJobRecord | null }>(`/api/goals/${goalId}`)).body
}

stackTest('phase 7 durable Goal, Workflow, Cron, and background control plane', async () => {
  const sessions = (await request<{ sessions: SessionRecord[] }>('/api/sessions')).body.sessions
  for (const open of sessions.filter(candidate => candidate.status !== 'closed')) await post(`/api/sessions/${open.id}/close`).catch(() => undefined)
  for (const open of sessions.filter(candidate => candidate.status !== 'closed')) {
    await waitFor(() => sessionSnapshot(open.id), value => value.session?.status === 'closed').catch(() => undefined)
  }

  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 7 ${crypto.randomUUID().slice(0, 8)}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a', mode: 'shared', readOnly: false,
  })).workspace
  const session = (await post<{ session: SessionRecord }>('/api/sessions', {
    permissionMode: 'acceptEdits', workspaceId: workspace.id,
  })).session
  await waitFor(() => sessionSnapshot(session.id), value => value.session?.status === 'idle' && value.session.processState === 'running')

  const definitions = await waitFor(
    async () => (await request<{ definitions: WorkflowDefinitionRecord[] }>(`/api/workflows?sessionId=${session.id}`)).body.definitions,
    value => value.some(definition => definition.name === 'phase-seven'),
  )
  const discovered = definitions.find(definition => definition.name === 'phase-seven')!
  expect(discovered.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(discovered.steps).toHaveLength(2)

  const goalKey = `phase7-goal-${crypto.randomUUID()}`
  const firstGoal = await post<{ goal: GoalRecord; job: BackgroundJobRecord }>('/api/goals', {
    sessionId: session.id, objective: 'Phase 7 evidence goal', continuationLimit: 2,
  }, goalKey)
  const repeatedGoal = await post<{ goal: GoalRecord; job: BackgroundJobRecord }>('/api/goals', {
    sessionId: session.id, objective: 'ignored idempotent duplicate', continuationLimit: 2,
  }, goalKey)
  expect(repeatedGoal.goal.id).toBe(firstGoal.goal.id)
  expect(repeatedGoal.job.id).toBe(firstGoal.job.id)
  const missingEvidence = await request(`/api/goals/${firstGoal.goal.id}/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  expect(missingEvidence.response.status).toBe(422)
  const completed = await post<{ goal: GoalRecord }>(`/api/goals/${firstGoal.goal.id}/complete`, { evidence: { test: 'phase7' } })
  expect(completed.goal).toMatchObject({ id: firstGoal.goal.id, status: 'completed', completionEvidence: { test: 'phase7' } })
  await waitFor(() => sessionSnapshot(session.id), value => value.session?.status === 'idle')

  const limited = (await post<{ goal: GoalRecord }>('/api/goals', {
    sessionId: session.id, objective: 'Return a result without claiming completion evidence.', continuationLimit: 1,
  })).goal
  const blocked = await waitFor(() => goalSnapshot(limited.id), value => value.goal.status === 'blocked')
  expect(blocked.goal.blockedAudit).toMatchObject({ reason: 'continuation_limit_exceeded', limit: 1 })
  await waitFor(() => sessionSnapshot(session.id), value => value.session?.status === 'idle')

  const runKey = `phase7-run-${crypto.randomUUID()}`
  const firstRun = await post<{ run: WorkflowRunRecord }>(`/api/workflows/${discovered.id}/runs`, { sessionId: session.id }, runKey)
  const repeatedRun = await post<{ run: WorkflowRunRecord }>(`/api/workflows/${discovered.id}/runs`, { sessionId: session.id }, runKey)
  expect(repeatedRun.run.id).toBe(firstRun.run.id)
  const workflow = await waitFor(
    async () => (await request<WorkflowSnapshot>(`/api/workflows/${discovered.id}`)).body,
    value => value.runs.some(run => run.id === firstRun.run.id && run.status === 'completed'),
  )
  const finishedRun = workflow.runs.find(run => run.id === firstRun.run.id)!
  expect(finishedRun.steps.map(step => ({ index: step.stepIndex, status: step.status, attempt: step.attempt }))).toEqual([
    { index: 0, status: 'completed', attempt: 1 },
    { index: 1, status: 'completed', attempt: 1 },
  ])

  const cronKey = `phase7-cron-${crypto.randomUUID()}`
  const schedule = (await post<{ schedule: CronScheduleRecord }>('/api/cron', {
    sessionId: session.id, name: 'phase7-clock', expression: '@every 1h', timezone: 'Asia/Shanghai', prompt: 'phase seven scheduled prompt',
  }, cronKey)).schedule
  const repeatedSchedule = (await post<{ schedule: CronScheduleRecord }>('/api/cron', {
    sessionId: session.id, name: 'ignored', expression: '@every 2h', timezone: 'UTC', prompt: 'ignored',
  }, cronKey)).schedule
  expect(repeatedSchedule.id).toBe(schedule.id)
  expect(schedule).toMatchObject({ timezone: 'Asia/Shanghai', misfirePolicy: 'run_once', status: 'active' })
  expect(new Date(schedule.nextRunAt!).getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1_000)
  await post(`/api/cron/${schedule.id}/cancel`)
  expect((await request<{ schedules: CronScheduleRecord[] }>(`/api/cron?sessionId=${session.id}`)).body.schedules.find(value => value.id === schedule.id)?.status).toBe('cancelled')

  const backgroundKey = `phase7-background-${crypto.randomUUID()}`
  const background = (await post<{ job: BackgroundJobRecord }>('/api/background-jobs', {
    sessionId: session.id, type: 'sleep', title: 'Phase 7 sleeper', prompt: 'wake later', delayMs: 3_600_000,
  }, backgroundKey)).job
  const repeatedBackground = (await post<{ job: BackgroundJobRecord }>('/api/background-jobs', {
    sessionId: session.id, type: 'sleep', title: 'ignored', prompt: 'ignored', delayMs: 0,
  }, backgroundKey)).job
  expect(repeatedBackground.id).toBe(background.id)
  const attached = await post<BackgroundJobSnapshot & { attached: true }>(`/api/background-jobs/${background.id}/attach?after=0`)
  expect(attached).toMatchObject({ attached: true, job: { id: background.id, status: 'sleeping' } })
  const stopped = await post<{ job: BackgroundJobRecord }>(`/api/background-jobs/${background.id}/stop`)
  expect(stopped.job.status).toBe('cancelled')

  const remote = await request('/api/background-jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ sessionId: session.id, type: 'remote_trigger', prompt: 'blocked' }),
  })
  expect(remote.response.status).toBe(501)
  expect(remote.body.error).toContain('authenticated external callback profile')

  const jobs = (await request<{ jobs: BackgroundJobRecord[] }>(`/api/background-jobs?sessionId=${session.id}`)).body.jobs
  expect(jobs.find(job => job.workflowRunId === firstRun.run.id)?.status).toBe('completed')
  expect(jobs.find(job => job.cronScheduleId === schedule.id)?.status).toBe('cancelled')
  expect(jobs.find(job => job.id === background.id)?.status).toBe('cancelled')
  await post(`/api/sessions/${session.id}/close`).catch(() => undefined)
}, 180_000)
