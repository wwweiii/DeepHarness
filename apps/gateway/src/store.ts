import type { Database } from '@deepharness/database'
import type {
  HarnessEvent,
  HarnessEventType,
  JsonValue,
  SessionRecord,
  WorkerCommand,
} from '@deepharness/protocol'

interface EventInput {
  id: string
  sessionId: string
  turnId: string | null
  type: HarnessEventType
  payload: Record<string, JsonValue>
  source: 'browser' | 'gateway' | 'worker'
  timestamp?: string
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
    lastEventSeq: Number(row.last_event_seq),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
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

export class GatewayStore {
  constructor(private readonly database: Database) {}

  async getActiveSession(): Promise<SessionRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM sessions
      WHERE status <> 'closed'
      ORDER BY created_at DESC
      LIMIT 1
    `
    const row = rows[0]
    return row ? sessionFromRow(row) : null
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM sessions WHERE id = ${sessionId}
    `
    const row = rows[0]
    return row ? sessionFromRow(row) : null
  }

  async listEvents(sessionId: string, afterSeq = 0): Promise<HarnessEvent[]> {
    const rows = await this.database<Record<string, unknown>[]>`
      SELECT * FROM session_events
      WHERE session_id = ${sessionId} AND seq > ${afterSeq}
      ORDER BY seq ASC
    `
    return rows.map(eventFromRow)
  }

  async appendEvent(input: EventInput): Promise<HarnessEvent> {
    return this.database.begin(async transaction => {
      const sequences = await transaction<{ last_event_seq: string }[]>`
        UPDATE sessions
        SET last_event_seq = last_event_seq + 1, updated_at = now()
        WHERE id = ${input.sessionId}
        RETURNING last_event_seq
      `
      const sequence = sequences[0]
      if (!sequence) throw new Error(`Session ${input.sessionId} does not exist`)

      const rows = await transaction<Record<string, unknown>[]>`
        INSERT INTO session_events (
          id, session_id, turn_id, seq, type, payload, source, created_at
        ) VALUES (
          ${input.id}, ${input.sessionId}, ${input.turnId},
          ${Number(sequence.last_event_seq)}, ${input.type},
          ${transaction.json(input.payload)}, ${input.source},
          ${input.timestamp ? new Date(input.timestamp) : new Date()}
        )
        RETURNING *
      `
      const row = rows[0]
      if (!row) throw new Error('Event insert returned no row')
      return eventFromRow(row)
    })
  }

  async createSession(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
    workspaceId: string
    permissionMode: string
    modelId: string | null
    workspacePath: string
  }): Promise<{ session: SessionRecord; command: WorkerCommand; created: boolean }> {
    return this.database.begin(async transaction => {
      const existingCommands = await transaction<{
        id: string
        session_id: string
        payload: {
          workspacePath: string
          permissionMode: string
          modelId: string | null
        }
      }[]>`
        SELECT id, session_id, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      const prior = existingCommands[0]
      if (prior) {
        const rows = await transaction<Record<string, unknown>[]>`
          SELECT * FROM sessions WHERE id = ${prior.session_id}
        `
        const row = rows[0]
        if (!row) throw new Error('Idempotent session command references a missing session')
        return {
          session: sessionFromRow(row),
          command: {
            id: prior.id,
            type: 'start_session',
            sessionId: prior.session_id,
            payload: prior.payload,
          },
          created: false,
        }
      }

      const active = await transaction<{ id: string }[]>`
        SELECT id FROM sessions WHERE status <> 'closed' LIMIT 1 FOR UPDATE
      `
      if (active.length > 0) throw new Error('ACTIVE_SESSION_EXISTS')

      const rows = await transaction<Record<string, unknown>[]>`
        INSERT INTO sessions (
          id, workspace_id, title, status, permission_mode, model_id
        ) VALUES (
          ${input.sessionId}, ${input.workspaceId}, 'New session', 'queued',
          ${input.permissionMode}, ${input.modelId}
        )
        RETURNING *
      `
      await transaction`
        INSERT INTO session_commands (
          id, idempotency_key, session_id, type, payload, status
        ) VALUES (
          ${input.commandId}, ${input.idempotencyKey}, ${input.sessionId},
          'start_session',
          ${transaction.json({
            workspacePath: input.workspacePath,
            permissionMode: input.permissionMode,
            modelId: input.modelId,
          })},
          'pending'
        )
      `
      const row = rows[0]
      if (!row) throw new Error('Session insert returned no row')
      return {
        session: sessionFromRow(row),
        command: {
          id: input.commandId,
          type: 'start_session',
          sessionId: input.sessionId,
          payload: {
            workspacePath: input.workspacePath,
            permissionMode: input.permissionMode,
            modelId: input.modelId,
          },
        },
        created: true,
      }
    })
  }

  async createPrompt(input: {
    sessionId: string
    turnId: string
    commandId: string
    idempotencyKey: string
    text: string
  }): Promise<{
    command: Extract<WorkerCommand, { type: 'prompt' }>
    created: boolean
  }> {
    return this.database.begin(async transaction => {
      const existing = await transaction<{ id: string; payload: { turnId: string; text: string } }[]>`
        SELECT id, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      const prior = existing[0]
      if (prior) {
        return {
          command: {
            id: prior.id,
            type: 'prompt',
            sessionId: input.sessionId,
            payload: prior.payload,
          },
          created: false,
        }
      }

      const sessions = await transaction<{ status: string }[]>`
        SELECT status FROM sessions WHERE id = ${input.sessionId} FOR UPDATE
      `
      const session = sessions[0]
      if (!session) throw new Error('SESSION_NOT_FOUND')
      if (!['idle', 'running'].includes(session.status)) throw new Error('SESSION_NOT_READY')

      await transaction`
        INSERT INTO turns (id, session_id, status)
        VALUES (${input.turnId}, ${input.sessionId}, 'queued')
      `
      if (session.status === 'idle') {
        await transaction`
          UPDATE sessions SET active_turn_id = ${input.turnId}, updated_at = now()
          WHERE id = ${input.sessionId}
        `
      }
      await transaction`
        INSERT INTO session_commands (
          id, idempotency_key, session_id, type, payload, status
        ) VALUES (
          ${input.commandId}, ${input.idempotencyKey}, ${input.sessionId}, 'prompt',
          ${transaction.json({ turnId: input.turnId, text: input.text })}, 'pending'
        )
      `
      return {
        command: {
          id: input.commandId,
          type: 'prompt',
          sessionId: input.sessionId,
          payload: { turnId: input.turnId, text: input.text },
        },
        created: true,
      }
    })
  }

  async createCancel(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
  }): Promise<{
    command: Extract<WorkerCommand, { type: 'cancel' }>
    created: boolean
  }> {
    return this.database.begin(async transaction => {
      const existing = await transaction<{
        id: string
        session_id: string
        payload: { turnId: string | null }
      }[]>`
        SELECT id, session_id, payload FROM session_commands
        WHERE idempotency_key = ${input.idempotencyKey}
      `
      const prior = existing[0]
      if (prior) {
        return {
          command: {
            id: prior.id,
            type: 'cancel',
            sessionId: prior.session_id,
            payload: prior.payload,
          },
          created: false,
        }
      }
      const sessions = await transaction<{ active_turn_id: string | null; status: string }[]>`
        SELECT active_turn_id, status FROM sessions
        WHERE id = ${input.sessionId} FOR UPDATE
      `
      const session = sessions[0]
      if (!session) throw new Error('SESSION_NOT_FOUND')
      if (!['running', 'cancelling'].includes(session.status)) {
        throw new Error('SESSION_NOT_RUNNING')
      }
      await transaction`
        UPDATE sessions SET status = 'cancelling', updated_at = now()
        WHERE id = ${input.sessionId}
      `
      await transaction`
        INSERT INTO session_commands (
          id, idempotency_key, session_id, type, payload, status
        ) VALUES (
          ${input.commandId}, ${input.idempotencyKey}, ${input.sessionId}, 'cancel',
          ${transaction.json({ turnId: session.active_turn_id })}, 'pending'
        )
      `
      return {
        command: {
          id: input.commandId,
          type: 'cancel',
          sessionId: input.sessionId,
          payload: { turnId: session.active_turn_id },
        },
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
      const prior = existing[0]
      if (prior) {
        return {
          command: {
            id: prior.id,
            sessionId: prior.session_id,
            type: prior.type,
            payload: prior.payload,
          } as WorkerCommand,
          created: false,
        }
      }

      const sessions = await transaction<{ status: string }[]>`
        SELECT status FROM sessions WHERE id = ${input.sessionId} FOR UPDATE
      `
      const session = sessions[0]
      if (!session) throw new Error('SESSION_NOT_FOUND')
      if (input.type !== 'resolve_permission' && session.status !== 'idle') {
        throw new Error('SESSION_NOT_IDLE')
      }
      if (input.type === 'resolve_permission') {
        const permissionId = String(input.payload.permissionRequestId ?? '')
        const pending = await transaction<{ id: string }[]>`
          SELECT id FROM permission_requests
          WHERE id = ${permissionId} AND session_id = ${input.sessionId}
            AND status = 'pending'
          FOR UPDATE
        `
        if (pending.length === 0) throw new Error('PERMISSION_NOT_PENDING')
      }

      await transaction`
        INSERT INTO session_commands (
          id, idempotency_key, session_id, type, payload, status
        ) VALUES (
          ${input.commandId}, ${input.idempotencyKey}, ${input.sessionId},
          ${input.type}, ${transaction.json(input.payload)}, 'pending'
        )
      `
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

  async pendingCommands(): Promise<WorkerCommand[]> {
    const rows = await this.database<{
      id: string
      session_id: string
      type: WorkerCommand['type']
      payload: WorkerCommand['payload']
    }[]>`
      SELECT id, session_id, type, payload FROM session_commands
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      payload: row.payload,
    })) as WorkerCommand[]
  }

  async markCommandDelivered(commandId: string): Promise<void> {
    await this.database`
      UPDATE session_commands
      SET status = 'delivered', attempt_count = attempt_count + 1
      WHERE id = ${commandId} AND status = 'pending'
    `
  }

  async markCommandResult(commandId: string, ok: boolean): Promise<void> {
    await this.database`
      UPDATE session_commands
      SET status = ${ok ? 'acked' : 'failed'}, acked_at = now()
      WHERE id = ${commandId}
    `
  }

  async registerWorker(worker: {
    id: string
    name: string
    maxConcurrency: number
    workspacePath: string
    version: string
    vendorCommit: string
    providerId: string
    credentialStatus: 'configured' | 'missing'
  }): Promise<void> {
    await this.database.begin(async transaction => {
      await transaction`
        INSERT INTO workers (
          id, name, status, max_concurrency, workspace_path,
          last_heartbeat_at, version, vendor_commit
        ) VALUES (
          ${worker.id}, ${worker.name}, 'online', ${worker.maxConcurrency},
          ${worker.workspacePath}, now(), ${worker.version}, ${worker.vendorCommit}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          status = 'online',
          max_concurrency = EXCLUDED.max_concurrency,
          workspace_path = EXCLUDED.workspace_path,
          last_heartbeat_at = now(),
          version = EXCLUDED.version,
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
        ON CONFLICT (id) DO UPDATE SET
          enabled = true,
          credential_status = EXCLUDED.credential_status,
          health_status = EXCLUDED.health_status,
          last_checked_at = now()
      `
    })
  }

  async workerOffline(workerId: string): Promise<void> {
    await this.database`
      UPDATE workers SET status = 'offline' WHERE id = ${workerId}
    `
  }

  async applyWorkerEvent(event: HarnessEvent): Promise<void> {
    const status = event.payload.status
    if (event.type === 'session.status_changed' && typeof status === 'string') {
      const agentSessionId = event.payload.agentSessionId
      const modelId = event.payload.modelId
      const permissionMode = event.payload.permissionMode
      const providerId = event.payload.providerId
      await this.database`
        UPDATE sessions SET
          status = ${status},
          agent_session_id = COALESCE(${typeof agentSessionId === 'string' ? agentSessionId : null}, agent_session_id),
          model_id = COALESCE(${typeof modelId === 'string' ? modelId : null}, model_id),
          permission_mode = COALESCE(${typeof permissionMode === 'string' ? permissionMode : null}, permission_mode),
          provider_id = COALESCE(${typeof providerId === 'string' ? providerId : null}, provider_id),
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
    if (event.type === 'session.configuration_changed') {
      const permissionMode = event.payload.permissionMode
      const modelId = event.payload.modelId
      await this.database`
        UPDATE sessions SET
          permission_mode = COALESCE(${typeof permissionMode === 'string' ? permissionMode : null}, permission_mode),
          model_id = COALESCE(${typeof modelId === 'string' ? modelId : null}, model_id),
          config_options = CASE WHEN ${Array.isArray(event.payload.configOptions)}
            THEN ${this.database.json(event.payload.configOptions ?? [])} ELSE config_options END,
          updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'prompt.queue_updated') {
      const depth = typeof event.payload.depth === 'number' ? event.payload.depth : 0
      await this.database`
        UPDATE sessions SET prompt_queue_depth = ${depth}, updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'turn.started' && event.turnId) {
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE turns SET status = 'running', started_at = now()
          WHERE id = ${event.turnId}
        `
        await transaction`
          UPDATE sessions SET status = 'running', active_turn_id = ${event.turnId}, updated_at = now()
          WHERE id = ${event.sessionId}
        `
      })
    }
    if (event.type === 'turn.completed' && event.turnId) {
      const stopReason = typeof event.payload.stopReason === 'string'
        ? event.payload.stopReason
        : null
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
        UPDATE sessions SET status = 'interrupted', active_turn_id = NULL, updated_at = now()
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
            ${String(event.payload.acpRequestId ?? '')},
            ${String(event.payload.toolCallId ?? '')},
            ${String(event.payload.toolName ?? 'UnknownTool')},
            'permission', ${this.database.json(event.payload.input ?? {})},
            ${this.database.json(event.payload.options ?? [])}, 'pending',
            ${new Date(String(event.payload.expiresAt))}
          )
          ON CONFLICT (id) DO NOTHING
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
      const status = String(event.payload.status ?? 'denied')
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE permission_requests SET
            status = ${status}, decision = ${transaction.json(event.payload)},
            resolved_at = now()
          WHERE id = ${String(event.payload.permissionRequestId ?? '')}
        `
        await transaction`
          INSERT INTO audit_logs (id, action, resource_type, resource_id, metadata)
          VALUES (
            ${crypto.randomUUID()}, 'permission.resolve', 'permission_request',
            ${String(event.payload.permissionRequestId ?? '')},
            ${transaction.json(event.payload)}
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
          ${numberOrNull(event.payload.inputTokens)},
          ${numberOrNull(event.payload.outputTokens)},
          ${numberOrNull(event.payload.cachedReadTokens)},
          ${numberOrNull(event.payload.cachedWriteTokens)},
          ${numberOrNull(event.payload.totalTokens)},
          ${numberOrNull(event.payload.costUsd)},
          ${this.database.json(event.payload)}
        )
      `
    }
  }
}
