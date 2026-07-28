import type { Database } from '@deepharness/database'
import type postgres from 'postgres'
import type {
  EventPage,
  HarnessEvent,
  HarnessEventType,
  JsonValue,
  SessionRecord,
  SessionRecoveryStrategy,
  WorkerCommand,
  WorkspaceRecord,
} from '@deepharness/protocol'

type Transaction = postgres.TransactionSql

interface EventInput {
  id: string
  sessionId: string
  turnId: string | null
  type: HarnessEventType
  payload: Record<string, JsonValue>
  source: 'browser' | 'gateway' | 'worker'
  timestamp?: string
}

export interface AppendEventResult {
  event: HarnessEvent
  inserted: boolean
}

interface WorkspaceRow {
  id: string
  name: string
  worker_id: string | null
  container_path: string
  mode: 'shared' | 'worktree'
  read_only: boolean
  metadata: Record<string, JsonValue>
  locked_by_session_id: string | null
  created_at: string
  updated_at: string
}

function sessionFromRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    agentSessionId: row.agent_session_id === null ? null : String(row.agent_session_id),
    workspaceId: String(row.workspace_id),
    workerId: row.worker_id === null ? null : String(row.worker_id),
    title: String(row.title),
    status: row.status as SessionRecord['status'],
    permissionMode: String(row.permission_mode),
    modelId: row.model_id === null ? null : String(row.model_id),
    providerId: String(row.provider_id ?? 'anthropic'),
    availableModes: Array.isArray(row.available_modes)
      ? row.available_modes as SessionRecord['availableModes']
      : [],
    availableModels: Array.isArray(row.available_models)
      ? row.available_models as SessionRecord['availableModels']
      : [],
    configOptions: Array.isArray(row.config_options)
      ? row.config_options as SessionRecord['configOptions']
      : [],
    promptQueueDepth: Number(row.prompt_queue_depth ?? 0),
    activeTurnId: row.active_turn_id === null ? null : String(row.active_turn_id),
    processState: (row.process_state ?? 'stopped') as SessionRecord['processState'],
    recoveryStrategy: row.recovery_strategy === null || row.recovery_strategy === undefined
      ? null
      : row.recovery_strategy as SessionRecord['recoveryStrategy'],
    recoveryError: row.recovery_error === null || row.recovery_error === undefined
      ? null
      : String(row.recovery_error),
    contextState: row.context_state && typeof row.context_state === 'object'
      ? row.context_state as Record<string, JsonValue>
      : {},
    parentSessionId: row.parent_session_id === null || row.parent_session_id === undefined
      ? null
      : String(row.parent_session_id),
    forkPointEventId: row.fork_point_event_id === null || row.fork_point_event_id === undefined
      ? null
      : String(row.fork_point_event_id),
    worktreePath: row.worktree_path === null || row.worktree_path === undefined
      ? null
      : String(row.worktree_path),
    lastEventSeq: Number(row.last_event_seq),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: String(row.id),
    name: row.name,
    workerId: row.worker_id,
    containerPath: row.container_path,
    mode: row.mode,
    readOnly: row.read_only,
    metadata: row.metadata ?? {},
    lockedBySessionId: row.locked_by_session_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function eventFromRow(row: Record<string, unknown>): HarnessEvent {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    seq: Number(row.seq),
    type: row.type as HarnessEventType,
    timestamp: new Date(String(row.created_at)).toISOString(),
    payload: row.payload as Record<string, JsonValue>,
  }
}

function commandFromRow(row: {
  id: string
  session_id: string
  type: WorkerCommand['type']
  payload: WorkerCommand['payload']
}): WorkerCommand {
  return {
    id: row.id,
    sessionId: row.session_id,
    type: row.type,
    payload: row.payload,
  } as WorkerCommand
}

export class GatewayStore {
  constructor(private readonly database: Database) {}

  async getActiveSession(): Promise<SessionRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM sessions
      WHERE status <> 'closed'
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `
    return rows[0] ? sessionFromRow(rows[0]) : null
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM sessions WHERE id = ${sessionId}
    `
    return rows[0] ? sessionFromRow(rows[0]) : null
  }

  async listSessions(limit = 100): Promise<SessionRecord[]> {
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}
    `
    return rows.map(sessionFromRow)
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const rows = await this.database<WorkspaceRow[]>`
      SELECT workspace.*, lock.session_id::text AS locked_by_session_id
      FROM workspaces workspace
      LEFT JOIN LATERAL (
        SELECT candidate.session_id FROM workspace_locks candidate
        JOIN workspaces locked_workspace ON locked_workspace.id = candidate.workspace_id
        WHERE workspace.mode = 'shared'
          AND locked_workspace.mode = 'shared'
          AND locked_workspace.container_path = workspace.container_path
        LIMIT 1
      ) lock ON true
      ORDER BY workspace.created_at ASC
    `
    return rows.map(workspaceFromRow)
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceRecord | null> {
    const rows = await this.database<WorkspaceRow[]>`
      SELECT workspace.*, lock.session_id::text AS locked_by_session_id
      FROM workspaces workspace
      LEFT JOIN LATERAL (
        SELECT candidate.session_id FROM workspace_locks candidate
        JOIN workspaces locked_workspace ON locked_workspace.id = candidate.workspace_id
        WHERE workspace.mode = 'shared'
          AND locked_workspace.mode = 'shared'
          AND locked_workspace.container_path = workspace.container_path
        LIMIT 1
      ) lock ON true
      WHERE workspace.id = ${workspaceId}
    `
    return rows[0] ? workspaceFromRow(rows[0]) : null
  }

  async createWorkspace(input: {
    id: string
    name: string
    containerPath: string
    mode: 'shared' | 'worktree'
    readOnly: boolean
    metadata: Record<string, JsonValue>
  }): Promise<WorkspaceRecord> {
    const rows = await this.database<WorkspaceRow[]>`
      INSERT INTO workspaces (id, name, container_path, mode, read_only, metadata)
      VALUES (
        ${input.id}, ${input.name}, ${input.containerPath}, ${input.mode},
        ${input.readOnly}, ${this.database.json(input.metadata)}
      )
      RETURNING *, NULL::text AS locked_by_session_id
    `
    if (!rows[0]) throw new Error('Workspace insert returned no row')
    return workspaceFromRow(rows[0])
  }

  async listEvents(sessionId: string, afterSeq = 0, limit?: number): Promise<HarnessEvent[]> {
    const capped = limit === undefined ? 100_000 : Math.min(Math.max(limit, 1), 1_000)
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM session_events
      WHERE session_id = ${sessionId} AND seq > ${afterSeq}
      ORDER BY seq ASC
      LIMIT ${capped}
    `
    return rows.map(eventFromRow)
  }

  async listHistory(sessionId: string, beforeSeq: number | null, limit: number): Promise<EventPage> {
    const capped = Math.min(Math.max(limit, 1), 200)
    const rows = beforeSeq === null
      ? await this.database<Record<string, unknown>[]>`
          SELECT * FROM session_events WHERE session_id = ${sessionId}
          ORDER BY seq DESC LIMIT ${capped + 1}
        `
      : await this.database<Record<string, unknown>[]>`
          SELECT * FROM session_events
          WHERE session_id = ${sessionId} AND seq < ${beforeSeq}
          ORDER BY seq DESC LIMIT ${capped + 1}
        `
    const hasMore = rows.length > capped
    const pageRows = rows.slice(0, capped)
    const events = pageRows.map(eventFromRow).reverse()
    return {
      events,
      nextBeforeSeq: hasMore && events[0] ? events[0].seq : null,
    }
  }

  async appendEvent(input: EventInput): Promise<AppendEventResult> {
    return this.database.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext(${input.sessionId}))`
      const existing = await transaction<Record<string, unknown>[]>`
        SELECT * FROM session_events WHERE id = ${input.id}
      `
      if (existing[0]) return { event: eventFromRow(existing[0]), inserted: false }

      const sequences = await transaction<{ last_event_seq: string }[]>`
        UPDATE sessions
        SET last_event_seq = last_event_seq + 1, updated_at = now()
        WHERE id = ${input.sessionId}
        RETURNING last_event_seq
      `
      if (!sequences[0]) throw new Error(`Session ${input.sessionId} does not exist`)
      const rows = await transaction<Record<string, unknown>[]>`
        INSERT INTO session_events (
          id, session_id, turn_id, seq, type, payload, source, created_at
        ) VALUES (
          ${input.id}, ${input.sessionId}, ${input.turnId},
          ${Number(sequences[0].last_event_seq)}, ${input.type},
          ${transaction.json(input.payload)}, ${input.source},
          ${input.timestamp ? new Date(input.timestamp) : new Date()}
        )
        RETURNING *
      `
      if (!rows[0]) throw new Error('Event insert returned no row')
      return { event: eventFromRow(rows[0]), inserted: true }
    })
  }

  async createSession(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
    workspaceId: string
    permissionMode: string
    modelId: string | null
    recoveryStrategy?: SessionRecoveryStrategy
    agentSessionId?: string | null
    sourceAgentSessionId?: string | null
    parentSessionId?: string | null
    forkPointEventId?: string | null
  }): Promise<{ session: SessionRecord; command: WorkerCommand; created: boolean }> {
    return this.database.begin(async transaction => {
      const existing = await transaction<{
        id: string
        session_id: string
        type: WorkerCommand['type']
        payload: WorkerCommand['payload']
      }[]>`
        SELECT id, session_id, type, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      if (existing[0]) {
        const rows = await transaction<Record<string, unknown>[]>`
          SELECT * FROM sessions WHERE id = ${existing[0].session_id}
        `
        if (!rows[0]) throw new Error('Idempotent command references a missing session')
        return { session: sessionFromRow(rows[0]), command: commandFromRow(existing[0]), created: false }
      }

      const workspaces = await transaction<WorkspaceRow[]>`
        SELECT workspace.*, NULL::text AS locked_by_session_id
        FROM workspaces workspace WHERE id = ${input.workspaceId} FOR UPDATE
      `
      const workspace = workspaces[0]
      if (!workspace) throw new Error('WORKSPACE_NOT_FOUND')
      await this.cleanupOrphanLocks(transaction)

      const strategy = input.recoveryStrategy ?? 'new'
      const rows = await transaction<Record<string, unknown>[]>`
        INSERT INTO sessions (
          id, agent_session_id, workspace_id, title, status, permission_mode,
          model_id, process_state, recovery_strategy, parent_session_id,
          fork_point_event_id
        ) VALUES (
          ${input.sessionId}, ${input.agentSessionId ?? null}, ${input.workspaceId},
          ${strategy === 'fork' ? 'Forked session' : 'New session'}, 'queued',
          ${input.permissionMode}, ${input.modelId}, 'queued', ${strategy},
          ${input.parentSessionId ?? null}, ${input.forkPointEventId ?? null}
        )
        RETURNING *
      `
      if (!rows[0]) throw new Error('Session insert returned no row')
      if (workspace.mode === 'shared') {
        await this.acquireWorkspaceLock(transaction, input.workspaceId, input.sessionId)
      }
      const payload: Extract<WorkerCommand, { type: 'start_session' }>['payload'] = {
        workspaceId: input.workspaceId,
        workspacePath: workspace.container_path,
        workspaceMode: workspace.mode,
        readOnly: workspace.read_only,
        permissionMode: input.permissionMode,
        modelId: input.modelId,
        recoveryStrategy: strategy,
        agentSessionId: input.agentSessionId ?? null,
        sourceAgentSessionId: input.sourceAgentSessionId ?? null,
      }
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: 'start_session',
        payload,
      })
      return {
        session: sessionFromRow(rows[0]),
        command: { id: input.commandId, type: 'start_session', sessionId: input.sessionId, payload },
        created: true,
      }
    })
  }

  async createPrompt(input: {
    sessionId: string
    turnId: string
    commandId: string
    recoveryCommandId: string
    idempotencyKey: string
    text: string
  }): Promise<{
    commands: WorkerCommand[]
    prompt: Extract<WorkerCommand, { type: 'prompt' }>
    created: boolean
  }> {
    return this.database.begin(async transaction => {
      const existing = await transaction<{
        id: string
        session_id: string
        payload: { turnId: string; text: string }
      }[]>`
        SELECT id, session_id, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      if (existing[0]) {
        const prompt: Extract<WorkerCommand, { type: 'prompt' }> = {
          id: existing[0].id,
          type: 'prompt',
          sessionId: existing[0].session_id,
          payload: existing[0].payload,
        }
        return { commands: [], prompt, created: false }
      }

      const rows = await transaction<Array<Record<string, unknown> & {
        container_path: string
        mode: 'shared' | 'worktree'
        read_only: boolean
      }>>`
        SELECT session.*, workspace.container_path, workspace.mode, workspace.read_only
        FROM sessions session
        JOIN workspaces workspace ON workspace.id = session.workspace_id
        WHERE session.id = ${input.sessionId}
        FOR UPDATE OF session, workspace
      `
      const session = rows[0]
      if (!session) throw new Error('SESSION_NOT_FOUND')
      if (session.status === 'closed' || session.status === 'recovery_required') {
        throw new Error('SESSION_NOT_READY')
      }

      const commands: WorkerCommand[] = []
      if (session.process_state !== 'running') {
        if (!session.agent_session_id) throw new Error('SESSION_HAS_NO_AGENT_TRANSCRIPT')
        await this.cleanupOrphanLocks(transaction)
        if (session.mode === 'shared') {
          await this.acquireWorkspaceLock(transaction, String(session.workspace_id), input.sessionId)
        }
        const payload: Extract<WorkerCommand, { type: 'start_session' }>['payload'] = {
          workspaceId: String(session.workspace_id),
          workspacePath: session.container_path,
          workspaceMode: session.mode,
          readOnly: session.read_only,
          permissionMode: String(session.permission_mode),
          modelId: session.model_id === null ? null : String(session.model_id),
          recoveryStrategy: 'resume',
          agentSessionId: String(session.agent_session_id),
          sourceAgentSessionId: null,
        }
        await this.insertCommand(transaction, {
          id: input.recoveryCommandId,
          idempotencyKey: `resume:${input.idempotencyKey}`,
          sessionId: input.sessionId,
          type: 'start_session',
          payload,
        })
        commands.push({
          id: input.recoveryCommandId,
          type: 'start_session',
          sessionId: input.sessionId,
          payload,
        })
        await transaction`
          UPDATE sessions SET status = 'queued', process_state = 'queued',
            recovery_strategy = 'resume', recovery_error = NULL, updated_at = now()
          WHERE id = ${input.sessionId}
        `
      }

      await transaction`
        INSERT INTO turns (id, session_id, status)
        VALUES (${input.turnId}, ${input.sessionId}, 'queued')
      `
      const prompt: Extract<WorkerCommand, { type: 'prompt' }> = {
        id: input.commandId,
        type: 'prompt',
        sessionId: input.sessionId,
        payload: { turnId: input.turnId, text: input.text },
      }
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: 'prompt',
        payload: prompt.payload,
      })
      commands.push(prompt)
      return { commands, prompt, created: true }
    })
  }

  async createRecovery(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
    strategy: 'resume' | 'load'
  }): Promise<{ command: WorkerCommand; created: boolean }> {
    return this.database.begin(async transaction => {
      const prior = await transaction<{
        id: string
        session_id: string
        type: WorkerCommand['type']
        payload: WorkerCommand['payload']
      }[]>`
        SELECT id, session_id, type, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      if (prior[0]) return { command: commandFromRow(prior[0]), created: false }
      const rows = await transaction<Array<Record<string, unknown> & {
        container_path: string
        mode: 'shared' | 'worktree'
        read_only: boolean
      }>>`
        SELECT session.*, workspace.container_path, workspace.mode, workspace.read_only
        FROM sessions session JOIN workspaces workspace ON workspace.id = session.workspace_id
        WHERE session.id = ${input.sessionId} FOR UPDATE OF session, workspace
      `
      const session = rows[0]
      if (!session) throw new Error('SESSION_NOT_FOUND')
      if (!session.agent_session_id) throw new Error('SESSION_HAS_NO_AGENT_TRANSCRIPT')
      if (session.process_state === 'running') throw new Error('SESSION_PROCESS_RUNNING')
      await this.cleanupOrphanLocks(transaction)
      if (session.mode === 'shared') {
        await this.acquireWorkspaceLock(transaction, String(session.workspace_id), input.sessionId)
      }
      const payload: Extract<WorkerCommand, { type: 'start_session' }>['payload'] = {
        workspaceId: String(session.workspace_id),
        workspacePath: session.container_path,
        workspaceMode: session.mode,
        readOnly: session.read_only,
        permissionMode: String(session.permission_mode),
        modelId: session.model_id === null ? null : String(session.model_id),
        recoveryStrategy: input.strategy,
        agentSessionId: String(session.agent_session_id),
        sourceAgentSessionId: null,
      }
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: 'start_session',
        payload,
      })
      await transaction`
        UPDATE sessions SET status = 'queued', process_state = 'queued',
          recovery_strategy = ${input.strategy}, recovery_error = NULL, updated_at = now()
        WHERE id = ${input.sessionId}
      `
      return {
        command: { id: input.commandId, type: 'start_session', sessionId: input.sessionId, payload },
        created: true,
      }
    })
  }

  async createCancel(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
  }): Promise<{ command: Extract<WorkerCommand, { type: 'cancel' }>; created: boolean }> {
    return this.database.begin(async transaction => {
      const existing = await transaction<{
        id: string
        session_id: string
        payload: { turnId: string | null }
      }[]>`
        SELECT id, session_id, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      if (existing[0]) {
        return {
          command: {
            id: existing[0].id,
            type: 'cancel',
            sessionId: existing[0].session_id,
            payload: existing[0].payload,
          },
          created: false,
        }
      }
      const sessions = await transaction<{ active_turn_id: string | null; status: string }[]>`
        SELECT active_turn_id, status FROM sessions WHERE id = ${input.sessionId} FOR UPDATE
      `
      if (!sessions[0]) throw new Error('SESSION_NOT_FOUND')
      if (!['running', 'cancelling'].includes(sessions[0].status)) throw new Error('SESSION_NOT_RUNNING')
      const payload = { turnId: sessions[0].active_turn_id }
      await transaction`
        UPDATE sessions SET status = 'cancelling', updated_at = now() WHERE id = ${input.sessionId}
      `
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: 'cancel',
        payload,
      })
      return {
        command: { id: input.commandId, type: 'cancel', sessionId: input.sessionId, payload },
        created: true,
      }
    })
  }

  async createControlCommand(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
    type: 'resolve_permission' | 'set_mode' | 'set_model'
    payload: Record<string, JsonValue>
  }): Promise<{ command: WorkerCommand; created: boolean }> {
    return this.database.begin(async transaction => {
      const existing = await transaction<{
        id: string
        session_id: string
        type: WorkerCommand['type']
        payload: WorkerCommand['payload']
      }[]>`
        SELECT id, session_id, type, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      if (existing[0]) return { command: commandFromRow(existing[0]), created: false }
      const sessions = await transaction<{ status: string; process_state: string }[]>`
        SELECT status, process_state FROM sessions WHERE id = ${input.sessionId} FOR UPDATE
      `
      if (!sessions[0]) throw new Error('SESSION_NOT_FOUND')
      if (sessions[0].process_state !== 'running') throw new Error('SESSION_PROCESS_STOPPED')
      if (input.type !== 'resolve_permission' && sessions[0].status !== 'idle') {
        throw new Error('SESSION_NOT_IDLE')
      }
      if (input.type === 'resolve_permission') {
        const permissionId = String(input.payload.permissionRequestId ?? '')
        const pending = await transaction<{ id: string }[]>`
          SELECT id FROM permission_requests
          WHERE id = ${permissionId} AND session_id = ${input.sessionId} AND status = 'pending'
          FOR UPDATE
        `
        if (pending.length === 0) throw new Error('PERMISSION_NOT_PENDING')
      }
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
      })
      return {
        command: {
          id: input.commandId,
          sessionId: input.sessionId,
          type: input.type,
          payload: input.payload,
        } as WorkerCommand,
        created: true,
      }
    })
  }

  async createClose(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
    removeCleanWorktree: boolean
  }): Promise<{ command: WorkerCommand | null; created: boolean }> {
    return this.database.begin(async transaction => {
      const prior = await transaction<{
        id: string
        session_id: string
        type: WorkerCommand['type']
        payload: WorkerCommand['payload']
      }[]>`
        SELECT id, session_id, type, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      if (prior[0]) return { command: commandFromRow(prior[0]), created: false }
      const sessions = await transaction<{ status: string; process_state: string }[]>`
        SELECT status, process_state FROM sessions WHERE id = ${input.sessionId} FOR UPDATE
      `
      if (!sessions[0]) throw new Error('SESSION_NOT_FOUND')
      if (sessions[0].status === 'closed') return { command: null, created: false }
      if (!['queued', 'starting', 'running'].includes(sessions[0].process_state)) {
        await transaction`
          UPDATE sessions SET status = 'closed', process_state = 'stopped',
            closed_at = now(), updated_at = now() WHERE id = ${input.sessionId}
        `
        await transaction`DELETE FROM workspace_locks WHERE session_id = ${input.sessionId}`
        return { command: null, created: true }
      }
      const payload = { removeCleanWorktree: input.removeCleanWorktree }
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: 'close_session',
        payload,
      })
      return {
        command: { id: input.commandId, type: 'close_session', sessionId: input.sessionId, payload },
        created: true,
      }
    })
  }

  async pendingCommands(): Promise<WorkerCommand[]> {
    const rows = await this.database<{
      id: string
      session_id: string
      type: WorkerCommand['type']
      payload: WorkerCommand['payload']
    }[]>`
      SELECT id, session_id, type, payload FROM session_commands
      WHERE status = 'pending' AND next_attempt_at <= now() AND attempt_count < 5
      ORDER BY created_at ASC
    `
    return rows.map(commandFromRow)
  }

  async retryTimedOutCommands(timeoutMs: number): Promise<WorkerCommand[]> {
    await this.database`
      UPDATE session_commands SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE status = 'delivered'
        AND delivered_at < now() - (${Math.max(timeoutMs, 1_000)} * interval '1 millisecond')
        AND attempt_count < 5
    `
    return this.pendingCommands()
  }

  async requeueUnackedCommands(): Promise<void> {
    await this.database`
      UPDATE session_commands SET status = 'pending', next_attempt_at = now(), updated_at = now()
      WHERE status = 'delivered' AND attempt_count < 5
    `
  }

  async markCommandDelivered(commandId: string): Promise<void> {
    await this.database`
      UPDATE session_commands SET status = 'delivered', attempt_count = attempt_count + 1,
        delivered_at = now(), updated_at = now(), last_error = NULL
      WHERE id = ${commandId} AND status = 'pending'
    `
  }

  async markCommandResult(commandId: string, ok: boolean, error?: string): Promise<void> {
    await this.database`
      UPDATE session_commands SET status = ${ok ? 'acked' : 'failed'}, acked_at = now(),
        updated_at = now(), last_error = ${error ?? null}
      WHERE id = ${commandId}
    `
  }

  async registerWorker(worker: {
    id: string
    name: string
    maxConcurrency: number
    workspaceRoots: string[]
    version: string
    vendorCommit: string
    providerId: string
    credentialStatus: 'configured' | 'missing'
  }): Promise<void> {
    await this.database.begin(async transaction => {
      await transaction`
        INSERT INTO workers (
          id, name, status, max_concurrency, workspace_path,
          last_heartbeat_at, version, vendor_commit, capabilities
        ) VALUES (
          ${worker.id}, ${worker.name}, 'online', ${worker.maxConcurrency},
          ${worker.workspaceRoots.join(',')}, now(), ${worker.version}, ${worker.vendorCommit},
          ${transaction.json({ workspaceRoots: worker.workspaceRoots })}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, status = 'online', max_concurrency = EXCLUDED.max_concurrency,
          workspace_path = EXCLUDED.workspace_path, capabilities = EXCLUDED.capabilities,
          last_heartbeat_at = now(), version = EXCLUDED.version,
          vendor_commit = EXCLUDED.vendor_commit
      `
      await transaction`
        INSERT INTO integrations (
          id, kind, name, enabled, credential_status, health_status,
          capabilities, last_checked_at
        ) VALUES (
          ${`provider:${worker.providerId}`}, 'provider', ${worker.providerId}, true,
          ${worker.credentialStatus},
          ${worker.credentialStatus === 'configured' ? 'configured' : 'not_tested'},
          '[]'::jsonb, now()
        )
        ON CONFLICT (id) DO UPDATE SET enabled = true,
          credential_status = EXCLUDED.credential_status,
          health_status = EXCLUDED.health_status, last_checked_at = now()
      `
      await this.cleanupOrphanLocks(transaction)
    })
  }

  async workerOffline(workerId: string): Promise<string[]> {
    return this.database.begin(async transaction => {
      await transaction`UPDATE workers SET status = 'offline' WHERE id = ${workerId}`
      await transaction`
        UPDATE session_commands SET status = 'pending', next_attempt_at = now(), updated_at = now()
        WHERE status = 'delivered' AND attempt_count < 5
      `
      const affected = await transaction<{ id: string }[]>`
        UPDATE sessions SET
          status = CASE WHEN status IN ('running', 'cancelling', 'starting') THEN 'interrupted' ELSE status END,
          process_state = 'stopped', active_turn_id = NULL,
          recovery_error = CASE WHEN status IN ('running', 'cancelling', 'starting')
            THEN 'Worker disconnected before the active process completed.' ELSE recovery_error END,
          updated_at = now()
        WHERE worker_id = ${workerId} AND status <> 'closed'
        RETURNING id
      `
      await transaction`
        UPDATE turns SET status = 'interrupted', error_code = 'worker_disconnected', finished_at = now()
        WHERE status IN ('queued', 'running')
          AND session_id IN (SELECT id FROM sessions WHERE worker_id = ${workerId})
      `
      await transaction`
        UPDATE permission_requests SET status = 'expired', resolved_at = now(),
          decision = '{"reason":"worker_disconnected"}'::jsonb
        WHERE status = 'pending'
          AND session_id IN (SELECT id FROM sessions WHERE worker_id = ${workerId})
      `
      await transaction`DELETE FROM workspace_locks WHERE worker_id = ${workerId}`
      await transaction`
        UPDATE agent_processes SET state = 'exited', exited_at = now()
        WHERE worker_id = ${workerId} AND exited_at IS NULL
      `
      return affected.map(row => row.id)
    })
  }

  async applyWorkerEvent(event: HarnessEvent): Promise<void> {
    const status = event.payload.status
    if (event.type === 'session.status_changed' && typeof status === 'string') {
      await this.database`
        UPDATE sessions SET
          status = ${status},
          process_state = COALESCE(${typeof event.payload.processState === 'string' ? event.payload.processState : null}, process_state),
          agent_session_id = COALESCE(${typeof event.payload.agentSessionId === 'string' ? event.payload.agentSessionId : null}, agent_session_id),
          model_id = COALESCE(${typeof event.payload.modelId === 'string' ? event.payload.modelId : null}, model_id),
          permission_mode = COALESCE(${typeof event.payload.permissionMode === 'string' ? event.payload.permissionMode : null}, permission_mode),
          provider_id = COALESCE(${typeof event.payload.providerId === 'string' ? event.payload.providerId : null}, provider_id),
          recovery_strategy = COALESCE(${typeof event.payload.recoveryStrategy === 'string' ? event.payload.recoveryStrategy : null}, recovery_strategy),
          recovery_error = CASE WHEN ${status === 'recovery_required'} THEN ${String(event.payload.message ?? 'Recovery failed')} ELSE NULL END,
          worktree_path = COALESCE(${typeof event.payload.worktreePath === 'string' ? event.payload.worktreePath : null}, worktree_path),
          available_modes = CASE WHEN ${Array.isArray(event.payload.availableModes)}
            THEN ${this.database.json(event.payload.availableModes ?? [])} ELSE available_modes END,
          available_models = CASE WHEN ${Array.isArray(event.payload.availableModels)}
            THEN ${this.database.json(event.payload.availableModels ?? [])} ELSE available_models END,
          config_options = CASE WHEN ${Array.isArray(event.payload.configOptions)}
            THEN ${this.database.json(event.payload.configOptions ?? [])} ELSE config_options END,
          worker_id = COALESCE(worker_id, (SELECT id FROM workers WHERE status = 'online' LIMIT 1)),
          updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'session.process_changed') {
      const processState = typeof event.payload.processState === 'string'
        ? event.payload.processState
        : 'stopped'
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE sessions SET process_state = ${processState},
            worktree_path = COALESCE(${typeof event.payload.cwd === 'string' ? event.payload.cwd : null}, worktree_path),
            updated_at = now() WHERE id = ${event.sessionId}
        `
        if (processState === 'running') {
          await transaction`
            UPDATE agent_processes SET state = 'exited', exited_at = now()
            WHERE session_id = ${event.sessionId} AND exited_at IS NULL
          `
          await transaction`
            INSERT INTO agent_processes (
              id, session_id, worker_id, pid, state, recovery_strategy
            ) VALUES (
              ${event.id}, ${event.sessionId},
              (SELECT worker_id FROM sessions WHERE id = ${event.sessionId}),
              ${typeof event.payload.pid === 'number' ? event.payload.pid : null},
              'running', ${typeof event.payload.recoveryStrategy === 'string' ? event.payload.recoveryStrategy : null}
            )
          `
          await transaction`
            UPDATE workspace_locks SET worker_id = (
              SELECT worker_id FROM sessions WHERE id = ${event.sessionId}
            ), heartbeat_at = now() WHERE session_id = ${event.sessionId}
          `
        } else if (processState === 'stopped' || processState === 'exited') {
          await transaction`DELETE FROM workspace_locks WHERE session_id = ${event.sessionId}`
          await transaction`
            UPDATE agent_processes SET state = ${processState}, exited_at = now(),
              exit_code = ${typeof event.payload.exitCode === 'number' ? event.payload.exitCode : null},
              stderr_tail = ${transaction.json(event.payload.stderrTail ?? [])}
            WHERE session_id = ${event.sessionId} AND exited_at IS NULL
          `
        }
      })
    }
    if (event.type === 'session.recovery_changed') {
      await this.database`
        UPDATE sessions SET
          recovery_strategy = COALESCE(${typeof event.payload.strategy === 'string' ? event.payload.strategy : null}, recovery_strategy),
          recovery_error = CASE WHEN ${event.payload.status === 'recovery_required'}
            THEN ${JSON.stringify(event.payload)} ELSE NULL END,
          updated_at = now() WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'context.updated') {
      await this.database`
        UPDATE sessions SET context_state = ${this.database.json(event.payload)}, updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'session.closed') {
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE sessions SET status = 'closed', process_state = 'stopped', closed_at = now(),
            active_turn_id = NULL, updated_at = now() WHERE id = ${event.sessionId}
        `
        await transaction`DELETE FROM workspace_locks WHERE session_id = ${event.sessionId}`
      })
    }
    if (event.type === 'session.configuration_changed') {
      await this.database`
        UPDATE sessions SET
          permission_mode = COALESCE(${typeof event.payload.permissionMode === 'string' ? event.payload.permissionMode : null}, permission_mode),
          model_id = COALESCE(${typeof event.payload.modelId === 'string' ? event.payload.modelId : null}, model_id),
          config_options = CASE WHEN ${Array.isArray(event.payload.configOptions)}
            THEN ${this.database.json(event.payload.configOptions ?? [])} ELSE config_options END,
          updated_at = now() WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'prompt.queue_updated') {
      await this.database`
        UPDATE sessions SET prompt_queue_depth = ${typeof event.payload.depth === 'number' ? event.payload.depth : 0},
          updated_at = now() WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'turn.started' && event.turnId) {
      await this.database.begin(async transaction => {
        await transaction`UPDATE turns SET status = 'running', started_at = now() WHERE id = ${event.turnId}`
        await transaction`
          UPDATE sessions SET status = 'running', active_turn_id = ${event.turnId}, updated_at = now()
          WHERE id = ${event.sessionId}
        `
      })
    }
    if (event.type === 'turn.completed' && event.turnId) {
      const stopReason = typeof event.payload.stopReason === 'string' ? event.payload.stopReason : null
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE turns SET status = 'completed', stop_reason = ${stopReason}, finished_at = now()
          WHERE id = ${event.turnId}
        `
        await transaction`
          UPDATE sessions SET status = 'idle', active_turn_id = NULL, updated_at = now()
          WHERE id = ${event.sessionId}
        `
      })
    }
    if (event.type === 'turn.failed' && event.turnId) {
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE turns SET status = 'failed', error_code = 'agent_error', finished_at = now()
          WHERE id = ${event.turnId}
        `
        await transaction`
          UPDATE sessions SET status = 'error', active_turn_id = NULL, updated_at = now()
          WHERE id = ${event.sessionId}
        `
      })
    }
    if (event.type === 'session.interrupted') {
      await this.database`
        UPDATE sessions SET status = 'interrupted', active_turn_id = NULL,
          recovery_error = ${String(event.payload.reason ?? 'session_interrupted')}, updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'permission.requested') {
      const requestId = String(event.payload.permissionRequestId ?? '')
      if (requestId) {
        await this.database`
          INSERT INTO permission_requests (
            id, session_id, turn_id, acp_request_id, tool_call_id, tool_name,
            kind, input, options, status, expires_at
          ) VALUES (
            ${requestId}, ${event.sessionId}, ${event.turnId},
            ${String(event.payload.acpRequestId ?? '')}, ${String(event.payload.toolCallId ?? '')},
            ${String(event.payload.toolName ?? 'UnknownTool')}, 'permission',
            ${this.database.json(event.payload.input ?? {})},
            ${this.database.json(event.payload.options ?? [])}, 'pending',
            ${new Date(String(event.payload.expiresAt))}
          ) ON CONFLICT (id) DO NOTHING
        `
      }
    }
    if (event.type === 'question.requested') {
      await this.database`
        UPDATE permission_requests SET kind = 'question'
        WHERE id = ${String(event.payload.permissionRequestId ?? '')}
      `
    }
    if (event.type === 'permission.resolved') {
      const resolvedStatus = String(event.payload.status ?? 'denied')
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE permission_requests SET status = ${resolvedStatus},
            decision = ${transaction.json(event.payload)}, resolved_at = now()
          WHERE id = ${String(event.payload.permissionRequestId ?? '')}
        `
        await transaction`
          INSERT INTO audit_logs (id, action, resource_type, resource_id, metadata)
          VALUES (
            ${crypto.randomUUID()}, 'permission.resolve', 'permission_request',
            ${String(event.payload.permissionRequestId ?? '')}, ${transaction.json(event.payload)}
          )
        `
      })
    }
    if (event.type === 'usage.updated') {
      const numberOrNull = (value: JsonValue | undefined): number | null =>
        typeof value === 'number' && Number.isFinite(value) ? value : null
      await this.database`
        INSERT INTO usage_records (
          id, session_id, turn_id, model_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, raw_usage
        ) VALUES (
          ${crypto.randomUUID()}, ${event.sessionId}, ${event.turnId},
          (SELECT model_id FROM sessions WHERE id = ${event.sessionId}),
          ${numberOrNull(event.payload.inputTokens)}, ${numberOrNull(event.payload.outputTokens)},
          ${numberOrNull(event.payload.cachedReadTokens)}, ${numberOrNull(event.payload.cachedWriteTokens)},
          ${numberOrNull(event.payload.totalTokens)}, ${numberOrNull(event.payload.costUsd)},
          ${this.database.json(event.payload)}
        )
      `
    }
  }

  private async insertCommand(
    transaction: Transaction,
    input: {
      id: string
      idempotencyKey: string
      sessionId: string
      type: WorkerCommand['type']
      payload: WorkerCommand['payload'] | Record<string, JsonValue>
    },
  ): Promise<void> {
    await transaction`
      INSERT INTO session_commands (
        id, idempotency_key, session_id, type, payload, status, next_attempt_at
      ) VALUES (
        ${input.id}, ${input.idempotencyKey}, ${input.sessionId}, ${input.type},
        ${transaction.json(input.payload)}, 'pending', now()
      )
    `
  }

  private async acquireWorkspaceLock(
    transaction: Transaction,
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    const workspaces = await transaction<{ container_path: string }[]>`
      SELECT container_path FROM workspaces WHERE id = ${workspaceId}
    `
    const containerPath = workspaces[0]?.container_path
    if (!containerPath) throw new Error('WORKSPACE_NOT_FOUND')
    await transaction`SELECT pg_advisory_xact_lock(hashtext(${`workspace-write:${containerPath}`}))`
    const owner = await transaction<{ session_id: string }[]>`
      SELECT lock.session_id::text
      FROM workspace_locks lock
      JOIN workspaces locked_workspace ON locked_workspace.id = lock.workspace_id
      WHERE locked_workspace.mode = 'shared'
        AND locked_workspace.container_path = ${containerPath}
      FOR UPDATE OF lock
    `
    if (owner[0] && owner[0].session_id !== sessionId) throw new Error('WORKSPACE_BUSY')
    await transaction`
      INSERT INTO workspace_locks (workspace_id, session_id, mode)
      VALUES (${workspaceId}, ${sessionId}, 'write')
      ON CONFLICT (workspace_id) DO UPDATE SET
        session_id = EXCLUDED.session_id, acquired_at = now(), heartbeat_at = now()
    `
  }

  private async cleanupOrphanLocks(transaction: Transaction): Promise<void> {
    await transaction`
      DELETE FROM workspace_locks lock
      WHERE NOT EXISTS (
        SELECT 1 FROM sessions session
        WHERE session.id = lock.session_id
          AND session.status <> 'closed'
          AND session.process_state IN ('queued', 'starting', 'running')
      )
    `
  }
}
