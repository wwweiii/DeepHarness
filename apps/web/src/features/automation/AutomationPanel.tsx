import { CheckCircle2, CircleAlert, Clock3, Link2, Pause, Play, Plus, Square, Workflow } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BackgroundJobRecord, BackgroundJobSnapshot, CronScheduleRecord, GoalRecord, WorkflowDefinitionRecord, WorkflowRunRecord } from '@deepharness/protocol'
import { requestId } from '../../lib/requestId.ts'

type AutomationData = {
  goals: GoalRecord[]
  definitions: WorkflowDefinitionRecord[]
  runs: WorkflowRunRecord[]
  schedules: CronScheduleRecord[]
  jobs: BackgroundJobRecord[]
}

async function loadAutomation(sessionId: string): Promise<AutomationData> {
  const [goals, workflows, cron, jobs] = await Promise.all([
    fetch(`/api/goals?sessionId=${encodeURIComponent(sessionId)}`).then(response => response.json()),
    fetch(`/api/workflows?sessionId=${encodeURIComponent(sessionId)}`).then(response => response.json()),
    fetch(`/api/cron?sessionId=${encodeURIComponent(sessionId)}`).then(response => response.json()),
    fetch(`/api/background-jobs?sessionId=${encodeURIComponent(sessionId)}`).then(response => response.json()),
  ])
  return { goals: goals.goals ?? [], definitions: workflows.definitions ?? [], runs: workflows.runs ?? [], schedules: cron.schedules ?? [], jobs: jobs.jobs ?? [] }
}

async function mutate<T = unknown>(path: string, method = 'POST', body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': requestId() },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status})`)
  return response.json() as Promise<T>
}

function stateIcon(status: string) {
  if (['completed'].includes(status)) return <CheckCircle2 size={14} aria-hidden="true" />
  if (['blocked', 'failed', 'orphaned', 'quota_exceeded'].includes(status)) return <CircleAlert size={14} aria-hidden="true" />
  if (['queued', 'sleeping', 'paused'].includes(status)) return <Pause size={14} aria-hidden="true" />
  return <Play size={14} aria-hidden="true" />
}

export function AutomationPanel({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<AutomationData | null>(null)
  const [tab, setTab] = useState<'goals' | 'workflows' | 'cron' | 'background'>('goals')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attached, setAttached] = useState<BackgroundJobSnapshot | null>(null)
  const [goalObjective, setGoalObjective] = useState('')
  const [cronExpression, setCronExpression] = useState('@every 1h')
  const [cronTimezone, setCronTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [cronPrompt, setCronPrompt] = useState('')
  const [backgroundType, setBackgroundType] = useState<'sleep' | 'brief' | 'away_summary' | 'monitor'>('sleep')
  const [backgroundPrompt, setBackgroundPrompt] = useState('')
  const [backgroundDelay, setBackgroundDelay] = useState('5')

  const reload = () => loadAutomation(sessionId).then(setData).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  useEffect(() => {
    setData(null)
    void reload()
    const timer = setInterval(() => void reload(), 2_000)
    return () => clearInterval(timer)
  }, [sessionId])

  const action = async (path: string, body?: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try { await mutate(path, 'POST', body); await reload() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const attach = async (job: BackgroundJobRecord) => {
    setBusy(true); setError(null)
    try {
      const after = attached?.job.id === job.id ? (attached.logs.at(-1)?.seq ?? 0) : 0
      const snapshot = await mutate<BackgroundJobSnapshot & { attached: true }>(`/api/background-jobs/${job.id}/attach?after=${after}`)
      setAttached(previous => previous?.job.id === job.id && after > 0
        ? { ...snapshot, logs: [...previous.logs, ...snapshot.logs] }
        : snapshot)
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const completeGoal = (goal: GoalRecord) => {
    const evidence = window.prompt('Completion evidence')?.trim()
    if (evidence) void action(`/api/goals/${goal.id}/complete`, { evidence })
  }

  if (!data) return <div className="automation-panel"><p>Loading automation state...</p></div>
  return <div className="automation-panel" data-testid="automation-panel">
    <header className="automation-header">
      <div><span className="eyebrow">Durable control plane</span><h2>Goals and automation</h2><code>{sessionId}</code></div>
      <div className="automation-summary"><span>{data.goals.filter(item => ['queued', 'running'].includes(item.status)).length} active goals</span><span>{data.jobs.filter(item => ['queued', 'running', 'sleeping'].includes(item.status)).length} background jobs</span></div>
    </header>
    <nav className="automation-tabs" aria-label="Automation views">
      {(['goals', 'workflows', 'cron', 'background'] as const).map(value => <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value}</button>)}
    </nav>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tab === 'goals' && <section className="automation-list">
      <form className="automation-create" onSubmit={event => { event.preventDefault(); const objective = goalObjective.trim(); if (objective) void action('/api/goals', { sessionId, objective }).then(() => setGoalObjective('')) }}>
        <input aria-label="Goal objective" placeholder="Goal objective" value={goalObjective} onChange={event => setGoalObjective(event.target.value)} />
        <button disabled={busy || !goalObjective.trim()} title="Create goal"><Plus size={14} /><span className="sr-only">Create goal</span></button>
      </form>
      {data.goals.length === 0 && <p className="activity-empty">No goals</p>}
      {data.goals.map(goal => <article className="automation-row" key={goal.id}>
        <div className="automation-row-icon">{stateIcon(goal.status)}</div><div className="automation-main"><strong>{goal.objective}</strong><small>{goal.status} · continuation {goal.continuationCount}/{goal.continuationLimit}</small>{goal.lastError && <span>{goal.lastError}</span>}{goal.completionEvidence !== null && <code>completion evidence recorded</code>}</div>
        <div className="automation-actions">{['queued', 'running', 'paused'].includes(goal.status) && <><button disabled={busy} title="Complete goal" onClick={() => completeGoal(goal)}><CheckCircle2 size={14} /><span className="sr-only">Complete goal</span></button><button disabled={busy} title="Stop goal" onClick={() => void action(`/api/goals/${goal.id}/stop`)}><Square size={14} /><span className="sr-only">Stop goal</span></button></>}</div>
      </article>)}
    </section>}
    {tab === 'workflows' && <section className="automation-list">
      {data.definitions.map(definition => <article className="automation-row" key={definition.id}><Workflow size={15} /><div className="automation-main"><strong>{definition.name}</strong><small>{definition.steps.length} steps · {definition.enabled ? 'enabled' : 'disabled'}</small></div>{definition.enabled && <button disabled={busy} title="Run workflow" onClick={() => void action(`/api/workflows/${definition.id}/runs`, { sessionId })}><Play size={14} /><span className="sr-only">Run workflow</span></button>}</article>)}
      {data.runs.map(run => <article className="automation-row" key={run.id}><div className="automation-row-icon">{stateIcon(run.status)}</div><div className="automation-main"><strong>Run {run.id.slice(0, 8)}</strong><small>{run.status} · step {run.currentStepIndex + 1}/{run.steps.length}</small></div>{['queued', 'running', 'retry_waiting'].includes(run.status) && <button disabled={busy} title="Cancel workflow" onClick={() => void action(`/api/workflow-runs/${run.id}/cancel`)}><Square size={14} /><span className="sr-only">Cancel workflow</span></button>}</article>)}
      {data.definitions.length === 0 && data.runs.length === 0 && <p className="activity-empty">No workflows</p>}
    </section>}
    {tab === 'cron' && <section className="automation-list">
      <form className="automation-create automation-create-wide" onSubmit={event => { event.preventDefault(); if (cronPrompt.trim()) void action('/api/cron', { sessionId, expression: cronExpression, timezone: cronTimezone, prompt: cronPrompt }).then(() => setCronPrompt('')) }}>
        <input aria-label="Cron expression" value={cronExpression} onChange={event => setCronExpression(event.target.value)} />
        <input aria-label="Cron timezone" value={cronTimezone} onChange={event => setCronTimezone(event.target.value)} />
        <input aria-label="Scheduled prompt" placeholder="Scheduled prompt" value={cronPrompt} onChange={event => setCronPrompt(event.target.value)} />
        <button disabled={busy || !cronPrompt.trim()} title="Create schedule"><Plus size={14} /><span className="sr-only">Create schedule</span></button>
      </form>
      {data.schedules.length === 0 && <p className="activity-empty">No schedules</p>}
      {data.schedules.map(schedule => <article className="automation-row" key={schedule.id}><Clock3 size={15} /><div className="automation-main"><strong>{schedule.name}</strong><small>{schedule.expression} · {schedule.timezone} · {schedule.status}</small><span>Next: {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : 'none'}</span></div>{schedule.status === 'active' && <button disabled={busy} title="Cancel schedule" onClick={() => void action(`/api/cron/${schedule.id}/cancel`)}><Square size={14} /><span className="sr-only">Cancel schedule</span></button>}</article>)}
    </section>}
    {tab === 'background' && <section className="automation-list">
      <form className="automation-create automation-create-wide" onSubmit={event => { event.preventDefault(); const delay = Math.max(0, Number(backgroundDelay) || 0); if (backgroundPrompt.trim()) void action('/api/background-jobs', { sessionId, type: backgroundType, prompt: backgroundPrompt, delayMs: delay * 60_000 }).then(() => setBackgroundPrompt('')) }}>
        <select aria-label="Background job type" value={backgroundType} onChange={event => setBackgroundType(event.target.value as typeof backgroundType)}><option value="sleep">Sleep</option><option value="brief">Brief</option><option value="away_summary">Away summary</option><option value="monitor">Monitor</option></select>
        <input aria-label="Delay in minutes" type="number" min="0" step="1" value={backgroundDelay} onChange={event => setBackgroundDelay(event.target.value)} />
        <input aria-label="Background prompt" placeholder="Background prompt" value={backgroundPrompt} onChange={event => setBackgroundPrompt(event.target.value)} />
        <button disabled={busy || !backgroundPrompt.trim()} title="Create background job"><Plus size={14} /><span className="sr-only">Create background job</span></button>
      </form>
      {data.jobs.length === 0 && <p className="activity-empty">No background jobs</p>}
      {data.jobs.map(job => <div className="automation-job" key={job.id}><article className="automation-row"><div className="automation-row-icon">{stateIcon(job.status)}</div><div className="automation-main"><strong>{job.title}</strong><small>{job.type} · {job.status} · cursor {job.logCursor}</small>{job.error && <span>{job.error}</span>}</div><div className="automation-actions"><button disabled={busy} title="Attach to background output" onClick={() => void attach(job)}><Link2 size={14} /><span className="sr-only">Attach to background output</span></button>{['queued', 'running', 'sleeping', 'orphaned', 'paused'].includes(job.status) && <button disabled={busy} title="Stop background job" onClick={() => void action(`/api/background-jobs/${job.id}/stop`)}><Square size={14} /><span className="sr-only">Stop background job</span></button>}</div></article>{attached?.job.id === job.id && <div className="automation-log" aria-live="polite">{attached.logs.length === 0 ? <span>No output yet</span> : attached.logs.map(log => <pre key={log.id}>{String(log.payload.message ?? '')}</pre>)}</div>}</div>)}
    </section>}
  </div>
}
