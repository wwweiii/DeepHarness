import type postgres from 'postgres'
import type {
  BackgroundJobRecord,
  BackgroundJobSnapshot,
  BackgroundJobStatus,
  BackgroundJobType,
  CronScheduleRecord,
  GoalRecord,
  GoalSnapshot,
  GoalStatus,
  HarnessEvent,
  JsonValue,
  MisfirePolicy,
  WorkflowDefinitionRecord,
  WorkflowRunRecord,
  WorkflowSnapshot,
  WorkflowStepRecord,
  WorkflowStepStatus,
} from '@deepharness/protocol'
import type { Database } from '@deepharness/database'
import { nextCronOccurrence } from './cron.ts'

type Transaction = postgres.TransactionSql

const goalStatuses = new Set<GoalStatus>([
  'draft', 'queued', 'running', 'paused', 'completed', 'blocked', 'stopped', 'failed', 'quota_exceeded',
])
const backgroundStatuses = new Set<BackgroundJobStatus>([
  'queued', 'running', 'sleeping', 'paused', 'completed', 'failed', 'cancelled', 'orphaned', 'quota_exceeded',
])
const workflowStepStatuses = new Set<WorkflowStepStatus>([
  'pending', 'running', 'retry_waiting', 'completed', 'failed', 'skipped', 'cancelled',
])

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function object(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {}
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString()
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function goalFromRow(row: Record<string, unknown>): GoalRecord {
  return {
    id: String(row.id), sessionId: String(row.session_id),
    vendorGoalId: row.vendor_goal_id == null ? null : String(row.vendor_goal_id),
    objective: String(row.objective), status: goalStatuses.has(row.status as GoalStatus) ? row.status as GoalStatus : 'failed',
    tokenBudget: numberOrNull(row.token_budget), continuationLimit: Number(row.continuation_limit ?? 3),
    continuationCount: Number(row.continuation_count ?? 0), completionEvidence: json(row.completion_evidence),
    blockedAudit: json(row.blocked_audit), permissionMode: String(row.permission_mode), workspaceId: String(row.workspace_id),
    nextContinuationAt: row.next_continuation_at == null ? null : iso(row.next_continuation_at),
    lastError: row.last_error == null ? null : String(row.last_error), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
  }
}

function workflowDefinitionFromRow(row: Record<string, unknown>): WorkflowDefinitionRecord {
  return {
    id: String(row.id), sessionId: row.session_id == null ? null : String(row.session_id), name: String(row.name),
    description: String(row.description ?? ''), sourcePath: row.source_path == null ? null : String(row.source_path),
    sourceHash: row.source_hash == null ? null : String(row.source_hash), enabled: row.enabled !== false,
    steps: Array.isArray(row.steps) ? row.steps as JsonValue[] : [], metadata: object(row.metadata),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  }
}

function workflowStepFromRow(row: Record<string, unknown>): WorkflowStepRecord {
  const status = row.status as WorkflowStepStatus
  return {
    id: String(row.id), runId: String(row.run_id), stepIndex: Number(row.step_index), name: String(row.name),
    prompt: String(row.prompt), status: workflowStepStatuses.has(status) ? status : 'failed', attempt: Number(row.attempt ?? 0),
    maxAttempts: Number(row.max_attempts ?? 1), input: json(row.input), output: json(row.output),
    error: row.error == null ? null : String(row.error), startedAt: row.started_at == null ? null : iso(row.started_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  }
}

function workflowRunFromRow(row: Record<string, unknown>, steps: WorkflowStepRecord[]): WorkflowRunRecord {
  return {
    id: String(row.id), definitionId: String(row.definition_id), sessionId: String(row.session_id),
    status: row.status as WorkflowRunRecord['status'], currentStepIndex: Number(row.current_step_index ?? 0),
    input: json(row.input), output: json(row.output), retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 1), cancelRequested: row.cancel_requested === true,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), startedAt: row.started_at == null ? null : iso(row.started_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at), steps,
  }
}

function backgroundFromRow(row: Record<string, unknown>): BackgroundJobRecord {
  const status = row.status as BackgroundJobStatus
  return {
    id: String(row.id), type: row.type as BackgroundJobRecord['type'],
    status: backgroundStatuses.has(status) ? status : 'failed', ownerSessionId: row.owner_session_id == null ? null : String(row.owner_session_id),
    workerId: row.worker_id == null ? null : String(row.worker_id), workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
    cronScheduleId: row.cron_schedule_id == null ? null : String(row.cron_schedule_id), goalId: row.goal_id == null ? null : String(row.goal_id),
    workflowRunId: row.workflow_run_id == null ? null : String(row.workflow_run_id), title: String(row.title), input: json(row.input), output: json(row.output),
    logCursor: Number(row.log_cursor ?? 0), continuationCount: Number(row.continuation_count ?? 0), maxContinuations: Number(row.max_continuations ?? 3),
    tokenBudget: numberOrNull(row.token_budget), spentTokens: Number(row.spent_tokens ?? 0), nextRunAt: row.next_run_at == null ? null : iso(row.next_run_at),
    lastHeartbeatAt: row.last_heartbeat_at == null ? null : iso(row.last_heartbeat_at), orphanedAt: row.orphaned_at == null ? null : iso(row.orphaned_at),
    error: row.error == null ? null : String(row.error), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    startedAt: row.started_at == null ? null : iso(row.started_at), finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  }
}

function cronFromRow(row: Record<string, unknown>): CronScheduleRecord {
  return {
    id: String(row.id), name: String(row.name), ownerSessionId: String(row.owner_session_id), jobId: String(row.job_id),
    expression: String(row.expression), timezone: String(row.timezone), misfirePolicy: row.misfire_policy as MisfirePolicy,
    maxCatchUp: Number(row.max_catch_up ?? 1), status: row.status as CronScheduleRecord['status'],
    nextRunAt: row.next_run_at == null ? null : iso(row.next_run_at), lastScheduledAt: row.last_scheduled_at == null ? null : iso(row.last_scheduled_at),
    lastStartedAt: row.last_started_at == null ? null : iso(row.last_started_at), lastCompletedAt: row.last_completed_at == null ? null : iso(row.last_completed_at),
    metadata: object(row.metadata), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  }
}

export async function appendAutomationEvent(database: Database, input: {
  id: string
  sessionId: string
  turnId?: string | null
  type: HarnessEvent['type']
  payload: Record<string, JsonValue>
  source?: 'browser' | 'gateway' | 'worker'
  timestamp?: string
}): Promise<HarnessEvent> {
  return database.begin(async transaction => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${input.sessionId}))`
    const existing = await transaction<Record<string, unknown>[]>`SELECT * FROM session_events WHERE id = ${input.id}`
    if (existing[0]) return {
      id: String(existing[0].id), sessionId: String(existing[0].session_id), turnId: existing[0].turn_id == null ? null : String(existing[0].turn_id),
      seq: Number(existing[0].seq), type: existing[0].type as HarnessEvent['type'], timestamp: iso(existing[0].created_at), payload: object(existing[0].payload),
    }
    const sequence = await transaction<{ last_event_seq: string }[]>`
      UPDATE sessions SET last_event_seq = last_event_seq + 1, updated_at = now()
      WHERE id = ${input.sessionId} RETURNING last_event_seq
    `
    if (!sequence[0]) throw new Error('SESSION_NOT_FOUND')
    const rows = await transaction<Record<string, unknown>[]>`
      INSERT INTO session_events (id, session_id, turn_id, seq, type, payload, source, created_at)
      VALUES (${input.id}, ${input.sessionId}, ${input.turnId ?? null}, ${Number(sequence[0].last_event_seq)},
        ${input.type}, ${transaction.json(input.payload)}, ${input.source ?? 'gateway'}, ${input.timestamp ? new Date(input.timestamp) : new Date()})
      RETURNING *
    `
    const row = rows[0]
    if (!row) throw new Error('EVENT_INSERT_FAILED')
    return { id: String(row.id), sessionId: String(row.session_id), turnId: row.turn_id == null ? null : String(row.turn_id), seq: Number(row.seq),
      type: row.type as HarnessEvent['type'], timestamp: iso(row.created_at), payload: object(row.payload) }
  })
}

export class AutomationStore {
  constructor(private readonly database: Database) {}

  async getGoal(id: string): Promise<GoalRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`SELECT * FROM goals WHERE id = ${id}`
    return rows[0] ? goalFromRow(rows[0]) : null
  }

  async listGoals(sessionId?: string): Promise<GoalRecord[]> {
    const rows = sessionId
      ? await this.database<Record<string, unknown>[]>`SELECT * FROM goals WHERE session_id = ${sessionId} ORDER BY created_at DESC`
      : await this.database<Record<string, unknown>[]>`SELECT * FROM goals ORDER BY created_at DESC`
    return rows.map(goalFromRow)
  }

  async createGoal(input: {
    id: string; sessionId: string; objective: string; tokenBudget?: number | null; continuationLimit?: number;
    permissionMode: string; workspaceId: string; idempotencyKey?: string
  }): Promise<{ goal: GoalRecord; job: BackgroundJobRecord; created: boolean }> {
    const intentKey = input.idempotencyKey ? `goal:${input.sessionId}:${input.idempotencyKey}` : null
    return this.database.begin(async transaction => {
      if (intentKey) {
        await transaction`SELECT pg_advisory_xact_lock(hashtext(${intentKey}))`
        const prior = await transaction<{ job_id: string }[]>`SELECT job_id FROM background_job_intents WHERE intent_key = ${intentKey}`
        if (prior[0]) {
          const rows = await transaction<Record<string, unknown>[]>`
            SELECT goal.* FROM goals goal JOIN background_jobs job ON job.goal_id = goal.id
            WHERE job.id = ${prior[0].job_id}
          `
          const jobRows = await transaction<Record<string, unknown>[]>`SELECT * FROM background_jobs WHERE id = ${prior[0].job_id}`
          if (rows[0] && jobRows[0]) return { goal: goalFromRow(rows[0]), job: backgroundFromRow(jobRows[0]), created: false }
        }
      }
      const existing = await transaction<Record<string, unknown>[]>`SELECT * FROM goals WHERE id = ${input.id}`
      if (existing[0]) {
        const jobs = await transaction<Record<string, unknown>[]>`SELECT * FROM background_jobs WHERE goal_id = ${input.id}`
        if (!jobs[0]) throw new Error('GOAL_JOB_MISSING')
        return { goal: goalFromRow(existing[0]), job: backgroundFromRow(jobs[0]), created: false }
      }
      const jobId = crypto.randomUUID()
      const rows = await transaction<Record<string, unknown>[]>`
        INSERT INTO goals (id, session_id, objective, status, token_budget, continuation_limit, permission_mode, workspace_id)
        VALUES (${input.id}, ${input.sessionId}, ${input.objective}, 'queued', ${input.tokenBudget ?? null},
          ${Math.max(0, Math.min(input.continuationLimit ?? 3, 100))}, ${input.permissionMode}, ${input.workspaceId}) RETURNING *
      `
      await transaction`
        INSERT INTO background_jobs (id, type, status, owner_session_id, workspace_id, goal_id, title, input,
          max_continuations, token_budget, next_run_at)
        VALUES (${jobId}, 'goal', 'queued', ${input.sessionId}, ${input.workspaceId}, ${input.id}, ${input.objective},
          ${transaction.json({ objective: input.objective })}, ${Math.max(0, Math.min(input.continuationLimit ?? 3, 100))}, ${input.tokenBudget ?? null}, now())
      `
      if (intentKey) await transaction`
        INSERT INTO background_job_intents (id, job_id, intent_key, kind, payload, status, applied_at)
        VALUES (${crypto.randomUUID()}, ${jobId}, ${intentKey}, 'goal.create', ${transaction.json({ goalId: input.id })}, 'applied', now())
      `
      const jobs = await transaction<Record<string, unknown>[]>`SELECT * FROM background_jobs WHERE id = ${jobId}`
      if (!rows[0] || !jobs[0]) throw new Error('GOAL_INSERT_FAILED')
      return { goal: goalFromRow(rows[0]), job: backgroundFromRow(jobs[0]), created: true }
    })
  }

  async updateGoal(id: string, patch: { status?: GoalStatus; completionEvidence?: JsonValue; blockedAudit?: JsonValue; nextContinuationAt?: string | null; lastError?: string | null; continuationCount?: number }): Promise<GoalRecord | null> {
    if (patch.status && !goalStatuses.has(patch.status)) throw new Error('INVALID_GOAL_STATUS')
    const rows = await this.database<Record<string, unknown>[]>`
      UPDATE goals SET status = COALESCE(${patch.status ?? null}, status),
        completion_evidence = COALESCE(${patch.completionEvidence === undefined ? null : this.database.json(patch.completionEvidence)}, completion_evidence),
        blocked_audit = COALESCE(${patch.blockedAudit === undefined ? null : this.database.json(patch.blockedAudit)}, blocked_audit),
        next_continuation_at = ${patch.nextContinuationAt === undefined ? null : patch.nextContinuationAt},
        last_error = COALESCE(${patch.lastError ?? null}, last_error), continuation_count = COALESCE(${patch.continuationCount ?? null}, continuation_count),
        completed_at = CASE WHEN ${patch.status === 'completed'} THEN now() ELSE completed_at END, updated_at = now()
      WHERE id = ${id} RETURNING *
    `
    return rows[0] ? goalFromRow(rows[0]) : null
  }

  async completeGoal(id: string, evidence: JsonValue): Promise<GoalRecord> {
    const hasEvidence = evidence !== null && evidence !== undefined
      && (typeof evidence !== 'string' || evidence.trim().length > 0)
      && (typeof evidence !== 'object' || Object.keys(evidence as object).length > 0)
    if (!hasEvidence) throw new Error('COMPLETION_EVIDENCE_REQUIRED')
    const goal = await this.updateGoal(id, { status: 'completed', completionEvidence: evidence, nextContinuationAt: null })
    if (!goal) throw new Error('GOAL_NOT_FOUND')
    await this.database`UPDATE background_jobs SET status = 'completed', output = ${this.database.json(evidence)}, finished_at = now(), next_run_at = NULL, updated_at = now() WHERE goal_id = ${id} AND status NOT IN ('completed', 'cancelled')`
    return goal
  }

  async blockGoal(id: string, audit: JsonValue): Promise<GoalRecord> {
    const hasReason = typeof audit === 'string' ? audit.trim().length > 0 : audit && typeof audit === 'object' && Object.keys(audit as object).length > 0
    if (!hasReason) throw new Error('BLOCKED_AUDIT_REQUIRED')
    const goal = await this.updateGoal(id, { status: 'blocked', blockedAudit: audit, nextContinuationAt: null })
    if (!goal) throw new Error('GOAL_NOT_FOUND')
    await this.database`UPDATE background_jobs SET status = 'failed', error = 'goal_blocked', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE goal_id = ${id} AND status NOT IN ('completed', 'cancelled')`
    return goal
  }

  async stopGoal(id: string): Promise<GoalRecord> {
    const goal = await this.updateGoal(id, { status: 'stopped', nextContinuationAt: null })
    if (!goal) throw new Error('GOAL_NOT_FOUND')
    await this.database`UPDATE background_jobs SET status = 'cancelled', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE goal_id = ${id} AND status NOT IN ('completed', 'cancelled')`
    return goal
  }

  async getWorkflowDefinition(id: string): Promise<WorkflowDefinitionRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`SELECT * FROM workflow_definitions WHERE id = ${id}`
    return rows[0] ? workflowDefinitionFromRow(rows[0]) : null
  }

  async listWorkflowDefinitions(sessionId?: string): Promise<WorkflowDefinitionRecord[]> {
    const rows = sessionId
      ? await this.database<Record<string, unknown>[]>`SELECT * FROM workflow_definitions WHERE session_id = ${sessionId} ORDER BY name`
      : await this.database<Record<string, unknown>[]>`SELECT * FROM workflow_definitions ORDER BY name`
    return rows.map(workflowDefinitionFromRow)
  }

  async upsertWorkflowDefinition(input: { id?: string; sessionId?: string | null; name: string; description?: string; sourcePath?: string | null; sourceHash?: string | null; steps: JsonValue[]; metadata?: Record<string, JsonValue> }): Promise<WorkflowDefinitionRecord> {
    const id = input.id ?? crypto.randomUUID()
    const rows = await this.database<Record<string, unknown>[]>`
      INSERT INTO workflow_definitions (id, session_id, name, description, source_path, source_hash, steps, metadata)
      VALUES (${id}, ${input.sessionId ?? null}, ${input.name}, ${input.description ?? ''}, ${input.sourcePath ?? null}, ${input.sourceHash ?? null}, ${this.database.json(input.steps)}, ${this.database.json(input.metadata ?? {})})
      ON CONFLICT (session_id, name) DO UPDATE SET description = EXCLUDED.description, source_path = EXCLUDED.source_path,
        source_hash = EXCLUDED.source_hash, steps = EXCLUDED.steps, metadata = EXCLUDED.metadata, updated_at = now()
      RETURNING *
    `
    if (!rows[0]) throw new Error('WORKFLOW_DEFINITION_INSERT_FAILED')
    return workflowDefinitionFromRow(rows[0])
  }

  async createWorkflowRun(input: { id?: string; definitionId: string; sessionId: string; value?: JsonValue; maxRetries?: number; idempotencyKey?: string }): Promise<{ run: WorkflowRunRecord; created: boolean }> {
    const definition = await this.getWorkflowDefinition(input.definitionId)
    if (!definition || !definition.enabled) throw new Error('WORKFLOW_DEFINITION_NOT_FOUND')
    const id = input.id ?? crypto.randomUUID()
    const steps = definition.steps.flatMap((value, index) => {
      const step = object(value)
      const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : ''
      if (!prompt) return []
      const requestedAttempts = Number(step.maxAttempts ?? 1)
      const maxAttempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.min(Math.floor(requestedAttempts), 20)) : 1
      return [{ id: crypto.randomUUID(), index, name: typeof step.name === 'string' ? step.name : `Step ${index + 1}`, prompt, maxAttempts }]
    })
    if (steps.length === 0) throw new Error('WORKFLOW_HAS_NO_EXECUTABLE_STEPS')
    const requestedRetries = input.maxRetries ?? 1
    const maxRetries = Number.isFinite(requestedRetries) ? Math.max(0, Math.min(Math.floor(requestedRetries), 20)) : 1
    const intentKey = input.idempotencyKey ? `workflow:${input.sessionId}:${input.definitionId}:${input.idempotencyKey}` : null
    return this.database.begin(async transaction => {
      if (intentKey) {
        await transaction`SELECT pg_advisory_xact_lock(hashtext(${intentKey}))`
        const prior = await transaction<Record<string, unknown>[]>`
          SELECT run.* FROM background_job_intents intent
          JOIN background_jobs job ON job.id = intent.job_id
          JOIN workflow_runs run ON run.id = job.workflow_run_id
          WHERE intent.intent_key = ${intentKey}
        `
        if (prior[0]) {
          const priorSteps = await transaction<Record<string, unknown>[]>`SELECT * FROM workflow_steps WHERE run_id = ${String(prior[0].id)} ORDER BY step_index`
          return { run: workflowRunFromRow(prior[0], priorSteps.map(workflowStepFromRow)), created: false }
        }
      }
      await transaction`
        INSERT INTO workflow_runs (id, definition_id, session_id, input, max_retries)
        VALUES (${id}, ${definition.id}, ${input.sessionId}, COALESCE(${transaction.json(input.value ?? null)}, 'null'::jsonb), ${maxRetries})
      `
      for (const step of steps) await transaction`
        INSERT INTO workflow_steps (id, run_id, step_index, name, prompt, max_attempts)
        VALUES (${step.id}, ${id}, ${step.index}, ${step.name}, ${step.prompt}, ${step.maxAttempts})
      `
      const jobId = crypto.randomUUID()
      await transaction`
        INSERT INTO background_jobs (id, type, status, owner_session_id, workspace_id, workflow_run_id,
          title, input, max_continuations, next_run_at)
        SELECT ${jobId}, 'workflow', 'queued', ${input.sessionId}, workspace_id, ${id},
          ${definition.name}, ${transaction.json({ input: input.value ?? null })}, ${Math.max(1, steps.length + 1)}, now()
        FROM sessions WHERE id = ${input.sessionId}
      `
      if (intentKey) await transaction`
        INSERT INTO background_job_intents (id, job_id, intent_key, kind, payload, status, applied_at)
        VALUES (${crypto.randomUUID()}, ${jobId}, ${intentKey}, 'workflow.run', ${transaction.json({ runId: id, definitionId: definition.id })}, 'applied', now())
      `
      const rows = await transaction<Record<string, unknown>[]>`SELECT * FROM workflow_runs WHERE id = ${id}`
      const stepRows = await transaction<Record<string, unknown>[]>`SELECT * FROM workflow_steps WHERE run_id = ${id} ORDER BY step_index`
      if (!rows[0]) throw new Error('WORKFLOW_RUN_INSERT_FAILED')
      return { run: workflowRunFromRow(rows[0], stepRows.map(workflowStepFromRow)), created: true }
    })
  }

  async listWorkflowRuns(sessionId?: string): Promise<WorkflowRunRecord[]> {
    const rows = sessionId
      ? await this.database<Record<string, unknown>[]>`SELECT * FROM workflow_runs WHERE session_id = ${sessionId} ORDER BY created_at DESC`
      : await this.database<Record<string, unknown>[]>`SELECT * FROM workflow_runs ORDER BY created_at DESC`
    const runs: WorkflowRunRecord[] = []
    for (const row of rows) {
      const steps = await this.database<Record<string, unknown>[]>`SELECT * FROM workflow_steps WHERE run_id = ${String(row.id)} ORDER BY step_index`
      runs.push(workflowRunFromRow(row, steps.map(workflowStepFromRow)))
    }
    return runs
  }

  async getWorkflowSnapshot(definitionId: string): Promise<WorkflowSnapshot | null> {
    const definition = await this.getWorkflowDefinition(definitionId)
    if (!definition) return null
    return { definition, runs: await this.listWorkflowRuns(definition.sessionId ?? undefined).then(rows => rows.filter(row => row.definitionId === definitionId)) }
  }

  async cancelWorkflowRun(id: string): Promise<WorkflowRunRecord | null> {
    return this.database.begin(async transaction => {
      const rows = await transaction<Record<string, unknown>[]>`
        UPDATE workflow_runs SET cancel_requested = true, status = 'cancelled', finished_at = now(), updated_at = now()
        WHERE id = ${id} AND status NOT IN ('completed', 'failed', 'cancelled') RETURNING *
      `
      if (!rows[0]) return null
      await transaction`UPDATE workflow_steps SET status = 'cancelled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE run_id = ${id} AND status IN ('pending', 'running', 'retry_waiting')`
      await transaction`UPDATE background_jobs SET status = 'cancelled', next_run_at = NULL, finished_at = now(), updated_at = now() WHERE workflow_run_id = ${id} AND status NOT IN ('completed', 'failed', 'cancelled')`
      const steps = await transaction<Record<string, unknown>[]>`SELECT * FROM workflow_steps WHERE run_id = ${id} ORDER BY step_index`
      return workflowRunFromRow(rows[0], steps.map(workflowStepFromRow))
    })
  }

  async getBackgroundJob(id: string): Promise<BackgroundJobRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`SELECT * FROM background_jobs WHERE id = ${id}`
    return rows[0] ? backgroundFromRow(rows[0]) : null
  }

  async listBackgroundJobs(sessionId?: string): Promise<BackgroundJobRecord[]> {
    const rows = sessionId
      ? await this.database<Record<string, unknown>[]>`SELECT * FROM background_jobs WHERE owner_session_id = ${sessionId} ORDER BY created_at DESC`
      : await this.database<Record<string, unknown>[]>`SELECT * FROM background_jobs ORDER BY created_at DESC`
    return rows.map(backgroundFromRow)
  }

  async getBackgroundSnapshot(id: string, after = 0): Promise<BackgroundJobSnapshot | null> {
    const job = await this.getBackgroundJob(id)
    if (!job) return null
    const rows = await this.database<Record<string, unknown>[]>`SELECT id, event_id::text AS event_id, session_id::text, message, payload, created_at FROM background_job_logs WHERE job_id = ${id} AND id > ${after} ORDER BY id LIMIT 500`
    return {
      job,
      attached: false,
      logs: rows.map(row => ({ id: row.event_id == null ? `job-log-${String(row.id)}` : String(row.event_id), sessionId: row.session_id == null ? '' : String(row.session_id), turnId: null, seq: Number(row.id), type: 'background.output_delta', timestamp: iso(row.created_at), payload: { message: String(row.message), ...(object(row.payload)) } })),
    }
  }

  async createBackgroundJob(input: {
    id?: string
    type: BackgroundJobType
    ownerSessionId: string
    workspaceId: string
    title: string
    prompt: string
    nextRunAt: Date
    tokenBudget?: number | null
    idempotencyKey: string
  }): Promise<{ job: BackgroundJobRecord; created: boolean }> {
    const intentKey = `background:${input.ownerSessionId}:${input.idempotencyKey}`
    return this.database.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${intentKey}))`
      const prior = await transaction<Record<string, unknown>[]>`
        SELECT job.* FROM background_job_intents intent
        JOIN background_jobs job ON job.id = intent.job_id
        WHERE intent.intent_key = ${intentKey}
      `
      if (prior[0]) return { job: backgroundFromRow(prior[0]), created: false }
      const id = input.id ?? crypto.randomUUID()
      const status: BackgroundJobStatus = input.nextRunAt.getTime() > Date.now() ? 'sleeping' : 'queued'
      const rows = await transaction<Record<string, unknown>[]>`
        INSERT INTO background_jobs (id, type, status, owner_session_id, workspace_id, title, input,
          max_continuations, token_budget, next_run_at)
        VALUES (${id}, ${input.type}, ${status}, ${input.ownerSessionId}, ${input.workspaceId}, ${input.title},
          ${transaction.json({ prompt: input.prompt })}, 1, ${input.tokenBudget ?? null}, ${input.nextRunAt})
        RETURNING *
      `
      await transaction`
        INSERT INTO background_job_intents (id, job_id, intent_key, kind, payload, status, applied_at)
        VALUES (${crypto.randomUUID()}, ${id}, ${intentKey}, 'background.create',
          ${transaction.json({ type: input.type })}, 'applied', now())
      `
      if (!rows[0]) throw new Error('BACKGROUND_JOB_INSERT_FAILED')
      return { job: backgroundFromRow(rows[0]), created: true }
    })
  }

  async listCronSchedules(sessionId?: string): Promise<CronScheduleRecord[]> {
    const rows = sessionId
      ? await this.database<Record<string, unknown>[]>`SELECT * FROM cron_schedules WHERE owner_session_id = ${sessionId} ORDER BY created_at DESC`
      : await this.database<Record<string, unknown>[]>`SELECT * FROM cron_schedules ORDER BY created_at DESC`
    return rows.map(cronFromRow)
  }

  async createCron(input: { id?: string; jobId?: string; name: string; ownerSessionId: string; expression: string; timezone: string; misfirePolicy?: MisfirePolicy; maxCatchUp?: number; title: string; prompt: string; workspaceId: string; tokenBudget?: number | null; nextRunAt: Date; idempotencyKey: string }): Promise<{ schedule: CronScheduleRecord; created: boolean }> {
    const id = input.id ?? crypto.randomUUID()
    const jobId = input.jobId ?? crypto.randomUUID()
    const intentKey = `cron:${input.ownerSessionId}:${input.idempotencyKey}`
    return this.database.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${intentKey}))`
      const prior = await transaction<Record<string, unknown>[]>`
        SELECT schedule.* FROM background_job_intents intent
        JOIN background_jobs job ON job.id = intent.job_id
        JOIN cron_schedules schedule ON schedule.id = job.cron_schedule_id
        WHERE intent.intent_key = ${intentKey}
      `
      if (prior[0]) return { schedule: cronFromRow(prior[0]), created: false }
      await transaction`
        INSERT INTO background_jobs (id, type, status, owner_session_id, workspace_id, title, input, token_budget, next_run_at)
        VALUES (${jobId}, 'cron', 'sleeping', ${input.ownerSessionId}, ${input.workspaceId}, ${input.title}, ${transaction.json({ prompt: input.prompt })}, ${input.tokenBudget ?? null}, ${input.nextRunAt})
      `
      await transaction`
        INSERT INTO cron_schedules (id, name, owner_session_id, job_id, expression, timezone, misfire_policy, max_catch_up, next_run_at)
        VALUES (${id}, ${input.name}, ${input.ownerSessionId}, ${jobId}, ${input.expression}, ${input.timezone}, ${input.misfirePolicy ?? 'run_once'}, ${Math.max(1, Math.min(input.maxCatchUp ?? 1, 100))}, ${input.nextRunAt})
      `
      await transaction`UPDATE background_jobs SET cron_schedule_id = ${id} WHERE id = ${jobId}`
      await transaction`
        INSERT INTO background_job_intents (id, job_id, intent_key, kind, payload, status, applied_at)
        VALUES (${crypto.randomUUID()}, ${jobId}, ${intentKey}, 'cron.create',
          ${transaction.json({ cronScheduleId: id })}, 'applied', now())
      `
      const rows = await transaction<Record<string, unknown>[]>`SELECT * FROM cron_schedules WHERE id = ${id}`
      if (!rows[0]) throw new Error('CRON_INSERT_FAILED')
      return { schedule: cronFromRow(rows[0]), created: true }
    })
  }

  async cancelCron(id: string): Promise<CronScheduleRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`UPDATE cron_schedules SET status = 'cancelled', next_run_at = NULL, updated_at = now() WHERE id = ${id} RETURNING *`
    if (!rows[0]) return null
    await this.database`UPDATE background_jobs SET status = 'cancelled', next_run_at = NULL, finished_at = now(), updated_at = now() WHERE cron_schedule_id = ${id} AND status NOT IN ('completed', 'cancelled')`
    return cronFromRow(rows[0])
  }

  async stopBackgroundJob(id: string): Promise<BackgroundJobRecord | null> {
    return this.database.begin(async transaction => {
      const rows = await transaction<Record<string, unknown>[]>`
        UPDATE background_jobs SET status = 'cancelled', next_run_at = NULL, finished_at = now(), updated_at = now()
        WHERE id = ${id} AND status NOT IN ('completed', 'cancelled') RETURNING *
      `
      if (!rows[0]) return null
      const row = rows[0]
      if (row.goal_id != null) await transaction`UPDATE goals SET status = 'stopped', next_continuation_at = NULL, updated_at = now() WHERE id = ${String(row.goal_id)} AND status NOT IN ('completed', 'stopped')`
      if (row.workflow_run_id != null) {
        await transaction`UPDATE workflow_runs SET status = 'cancelled', cancel_requested = true, finished_at = now(), updated_at = now() WHERE id = ${String(row.workflow_run_id)} AND status NOT IN ('completed', 'failed', 'cancelled')`
        await transaction`UPDATE workflow_steps SET status = 'cancelled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE run_id = ${String(row.workflow_run_id)} AND status IN ('pending', 'running', 'retry_waiting')`
      }
      if (row.cron_schedule_id != null) await transaction`UPDATE cron_schedules SET status = 'cancelled', next_run_at = NULL, updated_at = now() WHERE id = ${String(row.cron_schedule_id)} AND status = 'active'`
      return backgroundFromRow(row)
    })
  }

  async claimDueJobs(now = new Date(), limit = 25, maxActive = 8): Promise<BackgroundJobRecord[]> {
    return this.database.begin(async transaction => {
      const activeRows = await transaction<{ count: string }[]>`SELECT count(*) FROM background_jobs WHERE status = 'running'`
      const capacity = Math.max(0, Math.min(limit, maxActive - Number(activeRows[0]?.count ?? 0)))
      if (capacity === 0) return []
      const rows = await transaction<Record<string, unknown>[]>`
        SELECT job.* FROM background_jobs job
        WHERE job.status IN ('queued', 'sleeping', 'orphaned') AND (job.next_run_at IS NULL OR job.next_run_at <= ${now})
          AND NOT EXISTS (
            SELECT 1 FROM background_jobs active
            WHERE active.owner_session_id = job.owner_session_id AND active.status = 'running' AND active.id <> job.id
          )
          AND job.id IN (
            SELECT DISTINCT ON (candidate.owner_session_id) candidate.id
            FROM background_jobs candidate
            WHERE candidate.status IN ('queued', 'sleeping', 'orphaned')
              AND (candidate.next_run_at IS NULL OR candidate.next_run_at <= ${now})
            ORDER BY candidate.owner_session_id, COALESCE(candidate.next_run_at, candidate.created_at), candidate.created_at
          )
        ORDER BY COALESCE(job.next_run_at, job.created_at), job.created_at
        FOR UPDATE SKIP LOCKED LIMIT ${capacity}
      `
      const jobs: BackgroundJobRecord[] = []
      for (const row of rows) {
        await transaction`UPDATE background_jobs SET status = 'running', started_at = COALESCE(started_at, now()), last_heartbeat_at = now(), updated_at = now() WHERE id = ${String(row.id)}`
        jobs.push(backgroundFromRow({ ...row, status: 'running', started_at: row.started_at ?? now.toISOString(), last_heartbeat_at: now.toISOString() }))
      }
      return jobs
    })
  }

  async markJobWaiting(id: string, nextRunAt: Date, patch: { output?: JsonValue; continuationCount?: number; status?: BackgroundJobStatus; error?: string | null } = {}): Promise<void> {
    await this.database`
      UPDATE background_jobs SET status = ${patch.status ?? 'sleeping'}, next_run_at = ${nextRunAt},
        output = COALESCE(${patch.output === undefined ? null : this.database.json(patch.output)}, output),
        continuation_count = COALESCE(${patch.continuationCount ?? null}, continuation_count), error = COALESCE(${patch.error ?? null}, error),
        last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}
    `
  }

  async markJobFinished(id: string, status: 'completed' | 'failed' | 'cancelled' | 'quota_exceeded', output?: JsonValue, error?: string): Promise<void> {
    await this.database`UPDATE background_jobs SET status = ${status}, output = COALESCE(${output === undefined ? null : this.database.json(output)}, output), error = COALESCE(${error ?? null}, error), finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${id}`
  }

  async markJobPaused(id: string, error: string): Promise<void> {
    await this.database`UPDATE background_jobs SET status = 'paused', error = ${error}, next_run_at = NULL, last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}`
  }

  async markJobRunning(id: string): Promise<void> {
    await this.database`UPDATE background_jobs SET status = 'running', next_run_at = NULL, last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}`
  }

  async setJobDispatch(id: string, input: {
    turnId: string
    workerId?: string | null
    stepIndex?: number | null
    cronScheduledAt?: string | null
    cronPendingOccurrences?: string[]
    cronFollowUpAt?: string | null
  }): Promise<void> {
    const context: Record<string, JsonValue> = { currentTurnId: input.turnId }
    if (input.stepIndex !== undefined && input.stepIndex !== null) context.stepIndex = input.stepIndex
    if (input.cronScheduledAt !== undefined) context.cronScheduledAt = input.cronScheduledAt
    if (input.cronPendingOccurrences !== undefined) context.cronPendingOccurrences = input.cronPendingOccurrences
    if (input.cronFollowUpAt !== undefined) context.cronFollowUpAt = input.cronFollowUpAt
    await this.database`
      UPDATE background_jobs SET input = input || ${this.database.json(context)},
        worker_id = COALESCE(${input.workerId ?? null}, worker_id), status = 'running', next_run_at = NULL,
        error = NULL, orphaned_at = NULL, last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}
    `
  }

  async logJob(id: string, message: string, payload: Record<string, JsonValue> = {}, sessionId?: string, eventId?: string): Promise<void> {
    await this.database.begin(async transaction => {
      await transaction`INSERT INTO background_job_logs (job_id, session_id, event_id, message, payload) VALUES (${id}, ${sessionId ?? null}, ${eventId ?? null}, ${message}, ${transaction.json(payload)})`
      await transaction`UPDATE background_jobs SET log_cursor = log_cursor + 1, last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}`
    })
  }

  async recoverOrphans(timeoutMs = 120_000): Promise<number> {
    const rows = await this.database<{ id: string }[]>`
      UPDATE background_jobs job SET status = 'orphaned', orphaned_at = now(), next_run_at = now(),
        error = 'Worker or Gateway ownership was lost', updated_at = now()
      WHERE job.status = 'running'
        AND job.last_heartbeat_at < now() - (${Math.max(timeoutMs, 1_000)} * interval '1 millisecond')
        AND EXISTS (
          SELECT 1 FROM sessions session LEFT JOIN workers worker ON worker.id = session.worker_id
          WHERE session.id = job.owner_session_id
            AND (session.process_state <> 'running' OR session.status IN ('interrupted', 'error', 'recovery_required', 'closed')
              OR session.worker_id IS NULL OR worker.status IS DISTINCT FROM 'online')
        )
      RETURNING job.id
    `
    return rows.length
  }
}

async function settleCronRun(database: Database, row: Record<string, unknown>, failed: boolean): Promise<void> {
  const id = String(row.id)
  const schedules = await database<Record<string, unknown>[]>`SELECT * FROM cron_schedules WHERE job_id = ${id} AND status = 'active'`
  const schedule = schedules[0]
  if (!schedule || String(schedule.expression).trim() === '@once') {
    await database`UPDATE background_jobs SET status = ${failed ? 'failed' : 'completed'}, error = ${failed ? 'turn_failed' : null}, finished_at = now(), next_run_at = NULL, continuation_count = continuation_count + 1, updated_at = now() WHERE id = ${id}`
    if (schedule) await database`UPDATE cron_schedules SET status = 'cancelled', next_run_at = NULL, last_completed_at = CASE WHEN ${!failed} THEN now() ELSE last_completed_at END, updated_at = now() WHERE id = ${String(schedule.id)}`
    return
  }
  const context = object(row.input)
  const pending = Array.isArray(context.cronPendingOccurrences)
    ? context.cronPendingOccurrences.filter((value): value is string => typeof value === 'string')
    : []
  const followUpText = typeof context.cronFollowUpAt === 'string' ? context.cronFollowUpAt : null
  const followUp = followUpText && Number.isFinite(new Date(followUpText).getTime()) ? new Date(followUpText) : null
  const next = pending[0]
    ? new Date(pending[0])
    : followUp ?? nextCronOccurrence(String(schedule.expression), new Date(), String(schedule.timezone))
  if (!next || !Number.isFinite(next.getTime())) {
    await database`UPDATE background_jobs SET status = 'failed', error = 'cron_next_occurrence_unavailable', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${id}`
    await database`UPDATE cron_schedules SET status = 'paused', next_run_at = NULL, updated_at = now() WHERE id = ${String(schedule.id)}`
    return
  }
  const patch = database.json({
    currentTurnId: null,
    cronScheduledAt: null,
    cronPendingOccurrences: pending.slice(1),
    cronFollowUpAt: pending.length > 0 ? followUpText : null,
  })
  await database`
    UPDATE background_jobs SET status = 'sleeping', input = input || ${patch}, error = ${failed ? 'turn_failed' : null},
      finished_at = NULL, next_run_at = ${next}, continuation_count = continuation_count + 1, updated_at = now() WHERE id = ${id}
  `
  await database`
    UPDATE cron_schedules SET next_run_at = ${next},
      last_completed_at = CASE WHEN ${!failed} THEN now() ELSE last_completed_at END, updated_at = now()
    WHERE id = ${String(schedule.id)}
  `
}

export async function applyAutomationEvent(database: Database, event: HarnessEvent): Promise<void> {
  const payload = object(event.payload)
  if (event.type === 'workflow.created') {
    const definitionId = typeof payload.definitionId === 'string' ? payload.definitionId : null
    const name = typeof payload.name === 'string' ? payload.name : null
    if (definitionId && name) {
      await database`
        INSERT INTO workflow_definitions (id, session_id, name, description, source_path, source_hash, steps, metadata)
        VALUES (${definitionId}, ${event.sessionId}, ${name}, ${String(payload.description ?? '')},
          ${typeof payload.sourcePath === 'string' ? payload.sourcePath : null},
          ${typeof payload.sourceHash === 'string' ? payload.sourceHash : null},
          ${database.json(Array.isArray(payload.steps) ? payload.steps : [])}, ${database.json({ discoveredBy: 'worker' })})
        ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, source_path = EXCLUDED.source_path,
          source_hash = EXCLUDED.source_hash, steps = EXCLUDED.steps, metadata = workflow_definitions.metadata || EXCLUDED.metadata, updated_at = now()
      `
    }
  }
  const jobId = typeof payload.backgroundJobId === 'string' ? payload.backgroundJobId : null
  if (event.type === 'goal.created' || event.type === 'goal.updated' || event.type === 'goal.continuation_started'
    || event.type === 'goal.completed' || event.type === 'goal.blocked') {
    const id = typeof payload.goalId === 'string' ? payload.goalId : null
    if (id) {
      const status = typeof payload.status === 'string' && goalStatuses.has(payload.status as GoalStatus)
        ? payload.status as GoalStatus : null
      await database`
        UPDATE goals SET status = COALESCE(${status}, status),
          completion_evidence = COALESCE(${payload.completionEvidence === undefined ? null : database.json(payload.completionEvidence)}, completion_evidence),
          blocked_audit = COALESCE(${payload.blockedAudit === undefined ? null : database.json(payload.blockedAudit)}, blocked_audit),
          continuation_count = COALESCE(${typeof payload.continuationCount === 'number' ? payload.continuationCount : null}, continuation_count),
          next_continuation_at = ${typeof payload.nextContinuationAt === 'string' ? new Date(payload.nextContinuationAt) : null},
          last_error = COALESCE(${typeof payload.error === 'string' ? payload.error : null}, last_error),
          completed_at = CASE WHEN ${status === 'completed'} THEN now() ELSE completed_at END, updated_at = now()
        WHERE id = ${id}
      `
    }
  }
  if (event.type === 'background.created' || event.type === 'background.updated' || event.type === 'background.attached'
    || event.type === 'background.stopped' || event.type === 'background.output_delta') {
    const id = jobId ?? (typeof payload.jobId === 'string' ? payload.jobId : null)
    if (id) {
      const status = typeof payload.status === 'string' && backgroundStatuses.has(payload.status as BackgroundJobStatus)
        ? payload.status as BackgroundJobStatus : null
      await database`
        UPDATE background_jobs SET status = COALESCE(${status}, status),
          output = COALESCE(${payload.output === undefined ? null : database.json(payload.output)}, output),
          error = COALESCE(${typeof payload.error === 'string' ? payload.error : null}, error),
          last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}
      `
      if (event.type === 'background.output_delta') {
        await database`
          INSERT INTO background_job_logs (job_id, session_id, event_id, message, payload)
          VALUES (${id}, ${event.sessionId}, ${event.id}, ${String(payload.message ?? payload.text ?? '')}, ${database.json(payload)})
          ON CONFLICT DO NOTHING
        `
        await database`UPDATE background_jobs SET log_cursor = log_cursor + 1 WHERE id = ${id}`
      }
    }
  }
  if (event.type === 'workflow.run_started' || event.type === 'workflow.run_updated') {
    const runId = typeof payload.runId === 'string' ? payload.runId : null
    if (runId) {
      await database`
        UPDATE workflow_runs SET status = COALESCE(${typeof payload.status === 'string' ? payload.status : null}, status),
          current_step_index = COALESCE(${typeof payload.currentStepIndex === 'number' ? payload.currentStepIndex : null}, current_step_index),
          output = COALESCE(${payload.output === undefined ? null : database.json(payload.output)}, output), updated_at = now(),
          started_at = COALESCE(started_at, CASE WHEN ${payload.status === 'running'} THEN now() ELSE NULL END),
          finished_at = CASE WHEN ${['completed', 'failed', 'cancelled'].includes(String(payload.status))} THEN now() ELSE finished_at END
        WHERE id = ${runId}
      `
    }
  }
  if (event.type === 'workflow.step_updated') {
    const stepId = typeof payload.stepId === 'string' ? payload.stepId : null
    if (stepId) await database`
      UPDATE workflow_steps SET status = COALESCE(${typeof payload.status === 'string' ? payload.status : null}, status),
        attempt = COALESCE(${typeof payload.attempt === 'number' ? payload.attempt : null}, attempt),
        output = COALESCE(${payload.output === undefined ? null : database.json(payload.output)}, output),
        error = COALESCE(${typeof payload.error === 'string' ? payload.error : null}, error), updated_at = now()
      WHERE id = ${stepId}
    `
  }
  if (event.type === 'turn.completed' || event.type === 'turn.failed') {
    const rows = await database<Record<string, unknown>[]>`
      SELECT * FROM background_jobs WHERE owner_session_id = ${event.sessionId}
        AND input->>'currentTurnId' = ${event.turnId ?? ''} AND status = 'running'
    `
    for (const row of rows) {
      const id = String(row.id)
      await database`
        INSERT INTO background_job_logs (job_id, session_id, event_id, message, payload)
        VALUES (${id}, ${event.sessionId}, ${event.id}, ${event.type === 'turn.completed' ? 'turn completed' : 'turn failed'}, ${database.json(payload)})
        ON CONFLICT DO NOTHING
      `
      await database`UPDATE background_jobs SET log_cursor = log_cursor + 1, last_heartbeat_at = now(), updated_at = now() WHERE id = ${id}`
      const type = String(row.type)
      if (event.type === 'turn.failed') {
        if (type === 'workflow' && row.workflow_run_id != null) {
          const runId = String(row.workflow_run_id)
          const stepIndex = Number((object(row.input).stepIndex ?? 0))
          const stepRows = await database<{ max_attempts: number; attempt: number; retry_count: number; max_retries: number }[]>`
            SELECT step.max_attempts, step.attempt, run.retry_count, run.max_retries
            FROM workflow_steps step JOIN workflow_runs run ON run.id = step.run_id
            WHERE step.run_id = ${runId} AND step.step_index = ${stepIndex}
          `
          const step = stepRows[0]
          if (step && Number(step.attempt) < Number(step.max_attempts) && Number(step.retry_count) < Number(step.max_retries)) {
            await database`UPDATE workflow_steps SET status = 'retry_waiting', error = 'turn_failed', finished_at = NULL, updated_at = now() WHERE run_id = ${runId} AND step_index = ${stepIndex}`
            await database`UPDATE workflow_runs SET status = 'retry_waiting', retry_count = retry_count + 1, updated_at = now() WHERE id = ${runId}`
            await database`UPDATE background_jobs SET status = 'sleeping', error = 'turn_failed', next_run_at = now() + interval '1 second', continuation_count = continuation_count + 1, updated_at = now() WHERE id = ${id}`
          } else {
            await database`UPDATE workflow_steps SET status = 'failed', error = 'turn_failed', finished_at = now(), updated_at = now() WHERE run_id = ${runId} AND step_index = ${stepIndex}`
            await database`UPDATE workflow_runs SET status = 'failed', output = ${database.json({ error: 'turn_failed' })}, finished_at = now(), updated_at = now() WHERE id = ${runId}`
            await database`UPDATE background_jobs SET status = 'failed', error = 'turn_failed', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${id}`
          }
        } else if (type === 'cron') {
          await settleCronRun(database, row, true)
        } else {
          const nextCount = Number(row.continuation_count ?? 0) + 1
          const max = Number(row.max_continuations ?? 1)
          const retry = type === 'goal' && nextCount < max
          await database`UPDATE background_jobs SET status = ${retry ? 'sleeping' : 'failed'}, continuation_count = ${nextCount}, error = ${retry ? 'turn_failed' : 'continuation_limit_exceeded'}, next_run_at = ${retry ? new Date(Date.now() + 1_000) : null}, finished_at = ${retry ? null : new Date()}, updated_at = now() WHERE id = ${id}`
          if (row.goal_id != null) {
            if (retry) await database`UPDATE goals SET status = 'running', continuation_count = ${nextCount}, next_continuation_at = now() + interval '1 second', last_error = 'turn_failed', updated_at = now() WHERE id = ${String(row.goal_id)} AND status IN ('queued', 'running')`
            else await database`UPDATE goals SET status = 'blocked', continuation_count = ${nextCount}, blocked_audit = ${database.json({ reason: 'continuation_limit_exceeded', limit: max, observed: nextCount, trigger: 'turn_failed', requiresCompletionEvidence: true })}, next_continuation_at = NULL, last_error = 'continuation_limit_exceeded', updated_at = now() WHERE id = ${String(row.goal_id)} AND status IN ('queued', 'running')`
          }
        }
        continue
      }
      if (type === 'workflow') {
        const runId = row.workflow_run_id == null ? null : String(row.workflow_run_id)
        const stepIndex = Number((object(row.input).stepIndex ?? 0))
        if (runId) {
          const completed = await database<{ id: string }[]>`UPDATE workflow_steps SET status = 'completed', output = ${database.json({ turnId: event.turnId, stopReason: payload.stopReason ?? null })}, finished_at = now(), updated_at = now() WHERE run_id = ${runId} AND step_index = ${stepIndex} AND status = 'running' RETURNING id`
          if (completed.length === 0) continue
          await database`UPDATE workflow_runs SET current_step_index = ${stepIndex + 1}, status = 'queued', updated_at = now() WHERE id = ${runId} AND status <> 'cancelled'`
          const remaining = await database<{ count: string }[]>`SELECT count(*) FROM workflow_steps WHERE run_id = ${runId} AND status IN ('pending', 'running', 'retry_waiting')`
          if (Number(remaining[0]?.count ?? 0) === 0) {
            await database`UPDATE workflow_runs SET status = 'completed', finished_at = now(), updated_at = now() WHERE id = ${runId}`
            await database`UPDATE background_jobs SET status = 'completed', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${id}`
          } else {
            await database`UPDATE background_jobs SET status = 'sleeping', next_run_at = now(), continuation_count = continuation_count + 1, updated_at = now() WHERE id = ${id}`
          }
        }
      } else if (type === 'cron') {
        await settleCronRun(database, row, false)
      } else if (['sleep', 'brief', 'away_summary', 'monitor'].includes(type)) {
        await database`UPDATE background_jobs SET status = 'completed', output = ${database.json({ turnId: event.turnId, stopReason: payload.stopReason ?? null })}, continuation_count = continuation_count + 1, finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${id}`
      } else {
        const nextCount = Number(row.continuation_count ?? 0) + 1
        const max = Number(row.max_continuations ?? 3)
        if (nextCount >= max) {
          await database`UPDATE background_jobs SET status = 'failed', continuation_count = ${nextCount}, error = 'continuation_limit_exceeded', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${id}`
          if (row.goal_id != null) await database`UPDATE goals SET status = 'blocked', continuation_count = ${nextCount}, blocked_audit = ${database.json({ reason: 'continuation_limit_exceeded', limit: max, observed: nextCount, requiresCompletionEvidence: true })}, next_continuation_at = NULL, last_error = 'continuation_limit_exceeded', updated_at = now() WHERE id = ${String(row.goal_id)} AND status IN ('queued', 'running')`
        } else {
          await database`UPDATE background_jobs SET status = 'sleeping', continuation_count = ${nextCount}, next_run_at = now() + interval '1 second', updated_at = now() WHERE id = ${id}`
          if (row.goal_id != null) await database`UPDATE goals SET status = 'running', continuation_count = ${nextCount}, next_continuation_at = now() + interval '1 second', updated_at = now() WHERE id = ${String(row.goal_id)} AND status IN ('queued', 'running')`
        }
      }
    }
  }
  if (event.type === 'assistant.text_delta' || event.type === 'assistant.reasoning_delta' || event.type === 'tool.call_completed') {
    const rows = await database<Record<string, unknown>[]>`
      SELECT id FROM background_jobs
      WHERE owner_session_id = ${event.sessionId} AND input->>'currentTurnId' = ${event.turnId ?? ''}
        AND status IN ('running', 'sleeping', 'orphaned')
    `
    for (const row of rows) {
      const message = event.type === 'tool.call_completed'
        ? `tool ${String(payload.toolName ?? 'unknown')} ${String(payload.status ?? 'completed')}`
        : String(payload.text ?? '')
      if (!message) continue
      await database`
        INSERT INTO background_job_logs (job_id, session_id, event_id, message, payload)
        VALUES (${String(row.id)}, ${event.sessionId}, ${event.id}, ${message}, ${database.json({ eventType: event.type })})
        ON CONFLICT DO NOTHING
      `
      await database`UPDATE background_jobs SET log_cursor = log_cursor + 1, last_heartbeat_at = now(), updated_at = now() WHERE id = ${String(row.id)}`
    }
  }
  if (event.type === 'usage.updated') {
    const observed = numberOrNull(payload.totalTokens)
      ?? ((numberOrNull(payload.inputTokens) ?? 0) + (numberOrNull(payload.outputTokens) ?? 0))
    if (observed !== null && observed > 0) {
      const rows = await database<Record<string, unknown>[]>`
        SELECT id, token_budget, spent_tokens, goal_id, workflow_run_id, cron_schedule_id FROM background_jobs
        WHERE owner_session_id = ${event.sessionId} AND input->>'currentTurnId' = ${event.turnId ?? ''}
          AND status = 'running'
      `
      for (const row of rows) {
        const spent = Number(row.spent_tokens ?? 0) + observed
        const budget = numberOrNull(row.token_budget)
        await database`UPDATE background_jobs SET spent_tokens = ${spent}, last_heartbeat_at = now(), updated_at = now() WHERE id = ${String(row.id)}`
        if (budget !== null && spent >= budget) {
          await database`UPDATE background_jobs SET status = 'quota_exceeded', error = 'token_budget_exceeded', finished_at = now(), next_run_at = NULL, updated_at = now() WHERE id = ${String(row.id)}`
          if (row.goal_id != null) await database`UPDATE goals SET status = 'quota_exceeded', last_error = 'token_budget_exceeded', next_continuation_at = NULL, updated_at = now() WHERE id = ${String(row.goal_id)} AND status NOT IN ('completed', 'stopped')`
          if (row.workflow_run_id != null) await database`UPDATE workflow_runs SET status = 'blocked', output = ${database.json({ error: 'token_budget_exceeded' })}, finished_at = now(), updated_at = now() WHERE id = ${String(row.workflow_run_id)} AND status NOT IN ('completed', 'failed', 'cancelled')`
          if (row.cron_schedule_id != null) await database`UPDATE cron_schedules SET status = 'paused', next_run_at = NULL, metadata = metadata || ${database.json({ error: 'token_budget_exceeded' })}, updated_at = now() WHERE id = ${String(row.cron_schedule_id)} AND status = 'active'`
        }
      }
    }
  }
}
