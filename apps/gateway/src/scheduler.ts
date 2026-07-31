import type { WorkerCommand } from '@deepharness/protocol'
import type { GatewayStore } from './store.ts'
import { AutomationStore, appendAutomationEvent } from './automation.ts'
import type { Database } from '@deepharness/database'
import { missedCronOccurrences, nextCronOccurrence } from './cron.ts'

export { missedCronOccurrences, nextCronOccurrence } from './cron.ts'

export interface PromptDispatcher {
  createPrompt(input: {
    sessionId: string
    turnId: string
    commandId: string
    recoveryCommandId: string
    idempotencyKey: string
    text: string
  }): Promise<{ commands: WorkerCommand[]; prompt: Extract<WorkerCommand, { type: 'prompt' }>; created: boolean }>
  deliver(command: WorkerCommand): Promise<boolean>
  broadcast(event: Awaited<ReturnType<typeof appendAutomationEvent>>): void
}

export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private stopped = false
  private readonly intervalMs: number
  private readonly maxActiveJobs: number
  private readonly maxDispatchPerTick: number

  constructor(
    private readonly database: Database,
    private readonly automation: AutomationStore,
    private readonly store: GatewayStore,
    private readonly dispatcher: PromptDispatcher,
  ) {
    this.intervalMs = Math.max(100, Number.parseInt(process.env.SCHEDULER_INTERVAL_MS ?? '1000', 10))
    this.maxActiveJobs = Math.max(1, Number.parseInt(process.env.SCHEDULER_MAX_ACTIVE_JOBS ?? '8', 10) || 8)
    this.maxDispatchPerTick = Math.max(1, Number.parseInt(process.env.SCHEDULER_MAX_DISPATCH_PER_TICK ?? '8', 10) || 8)
  }

  start(): void {
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(now = new Date()): Promise<void> {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      await this.automation.recoverOrphans()
      const jobs = await this.automation.claimDueJobs(now, this.maxDispatchPerTick, this.maxActiveJobs)
      for (const job of jobs) await this.dispatchJob(job.id, now)
    } catch (error) {
      console.error(JSON.stringify({ service: 'gateway', event: 'scheduler_tick_failed', error: error instanceof Error ? error.message : String(error) }))
    } finally {
      this.ticking = false
    }
  }

  private async dispatchJob(jobId: string, now: Date): Promise<void> {
    const job = await this.automation.getBackgroundJob(jobId)
    if (!job || ['completed', 'cancelled', 'failed', 'quota_exceeded'].includes(job.status)) return
    if (!job.ownerSessionId) {
      await this.automation.markJobFinished(job.id, 'failed', null, 'owner_session_missing')
      return
    }
    const session = await this.store.getSession(job.ownerSessionId)
    if (!session || session.status === 'closed') {
      await this.automation.markJobFinished(job.id, 'failed', null, 'owner_session_closed')
      return
    }
    const input = job.input && typeof job.input === 'object' && !Array.isArray(job.input) ? job.input as Record<string, unknown> : {}
    const currentTurnId = typeof input.currentTurnId === 'string' ? input.currentTurnId : null
    if (session.status === 'recovery_required') {
      await this.automation.markJobPaused(job.id, 'owner_session_recovery_required')
      return
    }
    if (['running', 'waiting_permission', 'cancelling'].includes(session.status)) {
      if (currentTurnId && session.activeTurnId === currentTurnId) await this.automation.markJobRunning(job.id)
      else await this.automation.markJobWaiting(job.id, new Date(now.getTime() + 1_000), { status: 'sleeping', error: `owner_session_${session.status}` })
      return
    }
    if (currentTurnId && job.error === 'Worker or Gateway ownership was lost') {
      const turns = await this.database<{ status: string }[]>`SELECT status FROM turns WHERE id = ${currentTurnId}`
      if (turns[0] && ['completed', 'failed', 'interrupted'].includes(turns[0].status)) {
        await this.automation.markJobPaused(job.id, `recovery_required:${turns[0].status}_turn:${currentTurnId}`)
        await this.automation.logJob(job.id, 'recovery_required', { turnId: currentTurnId, turnStatus: turns[0].status }, job.ownerSessionId)
        return
      }
    }
    if (job.tokenBudget !== null && job.spentTokens >= job.tokenBudget) {
      await this.automation.markJobFinished(job.id, 'quota_exceeded', null, 'token_budget_exceeded')
      if (job.goalId) await this.automation.updateGoal(job.goalId, { status: 'quota_exceeded', lastError: 'token_budget_exceeded' })
      return
    }
    let prompt = typeof input.prompt === 'string' ? input.prompt : typeof input.objective === 'string' ? input.objective : job.title
    let stepIndex: number | null = null
    let stepAttempt: number | null = null
    let cronScheduledAt: string | null = null
    let cronPendingOccurrences: string[] = []
    let cronFollowUpAt: string | null = null
    if (job.cronScheduleId) {
      const schedule = (await this.automation.listCronSchedules(job.ownerSessionId)).find(value => value.id === job.cronScheduleId)
      if (!schedule || schedule.status !== 'active') {
        await this.automation.markJobFinished(job.id, 'cancelled', null, 'cron_schedule_inactive')
        return
      }
      if (job.nextRunAt) {
        const scheduledAt = new Date(job.nextRunAt)
        const storedPending = Array.isArray(input.cronPendingOccurrences)
          ? input.cronPendingOccurrences.filter((value): value is string => typeof value === 'string')
          : []
        const storedFollowUp = typeof input.cronFollowUpAt === 'string' ? input.cronFollowUpAt : null
        const missed = storedFollowUp
          ? [scheduledAt, ...storedPending.map(value => new Date(value)).filter(value => Number.isFinite(value.getTime()))]
          : missedCronOccurrences(schedule.expression, scheduledAt, now, schedule.timezone, schedule.misfirePolicy, schedule.maxCatchUp)
        if (missed.length === 0) {
          const next = nextCronOccurrence(schedule.expression, now, schedule.timezone)
          if (next) {
            await this.automation.markJobWaiting(job.id, next, { status: 'sleeping' })
            await this.database`UPDATE cron_schedules SET next_run_at = ${next}, updated_at = now() WHERE id = ${schedule.id}`
          } else {
            await this.automation.markJobFinished(job.id, 'completed')
            await this.database`UPDATE cron_schedules SET status = 'cancelled', next_run_at = NULL, updated_at = now() WHERE id = ${schedule.id}`
          }
          await appendAutomationEvent(this.database, {
            id: crypto.randomUUID(), sessionId: job.ownerSessionId, type: 'cron.run_missed',
            payload: { cronScheduleId: schedule.id, jobId: job.id, scheduledAt: job.nextRunAt, policy: schedule.misfirePolicy, status: 'skipped' },
          }).then(event => this.dispatcher.broadcast(event))
          return
        }
        cronScheduledAt = missed[0]!.toISOString()
        cronPendingOccurrences = missed.slice(1).map(value => value.toISOString())
        cronFollowUpAt = storedFollowUp ?? nextCronOccurrence(schedule.expression, now, schedule.timezone)?.toISOString() ?? null
        prompt = `[scheduled:${cronScheduledAt}]\n${prompt}`
      }
    }
    if (job.workflowRunId) {
      const run = (await this.automation.listWorkflowRuns(job.ownerSessionId)).find(value => value.id === job.workflowRunId)
      const step = run?.steps.find(value => value.status === 'pending' || value.status === 'retry_waiting')
      if (!run || run.cancelRequested || run.status === 'cancelled') {
        await this.automation.markJobFinished(job.id, 'cancelled')
        return
      }
      if (!step) {
        if (run.steps.some(value => value.status === 'running')) await this.automation.markJobPaused(job.id, 'recovery_required:workflow_step_still_running')
        else await this.automation.markJobFinished(job.id, run.status === 'failed' ? 'failed' : 'completed', run.output)
        return
      }
      stepIndex = step.stepIndex
      stepAttempt = step.attempt + 1
      prompt = step.prompt
      await this.database`
        UPDATE workflow_runs SET status = 'running', current_step_index = ${step.stepIndex}, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = ${run.id}
      `
      await this.database`UPDATE workflow_steps SET status = 'running', attempt = attempt + 1, started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = ${step.id}`
    }
    const marker = `[deepharness-job:${job.id}]`
    prompt = `${marker}\n${prompt}`
    const turnId = crypto.randomUUID()
    const commandId = crypto.randomUUID()
    let dispatchedTurnId: string | null = null
    try {
      const dispatchKey = job.cronScheduleId
        ? `cron:${job.id}:${cronScheduledAt ?? job.nextRunAt ?? job.continuationCount}`
        : job.workflowRunId
          ? `workflow:${job.id}:${stepIndex ?? 0}:${stepAttempt ?? 1}`
          : `background:${job.id}:${job.continuationCount}`
      const result = await this.store.createPrompt({
        sessionId: job.ownerSessionId, turnId, commandId, recoveryCommandId: crypto.randomUUID(),
        idempotencyKey: dispatchKey,
        text: prompt,
      })
      dispatchedTurnId = result.prompt.payload.turnId
      if (!result.created) {
        const turns = await this.database<{ status: string }[]>`SELECT status FROM turns WHERE id = ${dispatchedTurnId}`
        if (turns[0] && ['completed', 'failed', 'interrupted'].includes(turns[0].status)) {
          await this.automation.markJobPaused(job.id, `recovery_required:${turns[0].status}_turn:${dispatchedTurnId}`)
          await this.automation.logJob(job.id, 'recovery_required', { turnId: dispatchedTurnId, turnStatus: turns[0].status }, job.ownerSessionId)
          return
        }
      }
      await this.automation.setJobDispatch(job.id, {
        turnId: dispatchedTurnId, workerId: session.workerId, stepIndex,
        cronScheduledAt, cronPendingOccurrences, cronFollowUpAt,
      })
      if (job.goalId) await this.automation.updateGoal(job.goalId, { status: 'running', nextContinuationAt: null })
      for (const command of result.commands) {
        if (!await this.dispatcher.deliver(command)) throw new Error('WORKER_OFFLINE')
      }
      const event = await appendAutomationEvent(this.database, {
        id: crypto.randomUUID(), sessionId: job.ownerSessionId, turnId: dispatchedTurnId,
        type: job.goalId ? 'goal.continuation_started' : job.workflowRunId ? 'workflow.run_started' : job.cronScheduleId ? 'cron.run_started' : 'background.updated',
        payload: { jobId: job.id, ...(job.goalId ? { goalId: job.goalId, status: 'running' } : {}), ...(job.workflowRunId ? { runId: job.workflowRunId, status: 'running', currentStepIndex: stepIndex ?? 0 } : {}), ...(job.cronScheduleId ? { cronScheduleId: job.cronScheduleId } : {}), status: 'running' },
      })
      this.dispatcher.broadcast(event)
      await this.automation.logJob(job.id, 'dispatched', { turnId: dispatchedTurnId, stepIndex, cronScheduledAt }, job.ownerSessionId, event.id)
      if (job.type === 'cron' && job.cronScheduleId) {
        const schedules = await this.automation.listCronSchedules(job.ownerSessionId)
        const schedule = schedules.find(value => value.id === job.cronScheduleId)
        if (schedule) await this.database`UPDATE cron_schedules SET last_scheduled_at = ${cronScheduledAt ? new Date(cronScheduledAt) : now}, last_started_at = now(), updated_at = now() WHERE id = ${schedule.id}`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!dispatchedTurnId && job.workflowRunId && stepIndex !== null) {
        await this.database`UPDATE workflow_steps SET status = 'retry_waiting', attempt = GREATEST(attempt - 1, 0), updated_at = now() WHERE run_id = ${job.workflowRunId} AND step_index = ${stepIndex} AND status = 'running'`
        await this.database`UPDATE workflow_runs SET status = 'retry_waiting', updated_at = now() WHERE id = ${job.workflowRunId} AND status = 'running'`
      }
      await this.automation.markJobWaiting(job.id, new Date(now.getTime() + 2_000), { error: message, status: message === 'WORKER_OFFLINE' ? 'orphaned' : 'sleeping' })
      await this.automation.logJob(job.id, 'dispatch_failed', { error: message }, job.ownerSessionId)
    }
  }
}
