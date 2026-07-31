import type { Database } from '@deepharness/database'
import type postgres from 'postgres'
import type {
  ActivityLimits,
  AgentActivityRecord,
  AgentDefinitionSummary,
  AvailableCommand,
  ContextCapabilityRecord,
  ContextCheckpointRecord,
  ContextUsageRecord,
  DataLifecycleBoundary,
  EventPage,
  ExtensionAuditRecord,
  ExtensionEntry,
  HarnessEvent,
  HarnessEventType,
  JsonValue,
  SessionRecord,
  SessionRecoveryStrategy,
  SessionActivitySnapshot,
  SessionExtensionSnapshot,
  TaskActivityRecord,
  TeamActivityRecord,
  TeamMessageRecord,
  TeamPeerRecord,
  McpServerStatus,
  MemoryObservationRecord,
  SessionContextSnapshot,
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
    createdVendorCommit: row.created_vendor_commit === null || row.created_vendor_commit === undefined
      ? null
      : String(row.created_vendor_commit),
    lastVendorCommit: row.last_vendor_commit === null || row.last_vendor_commit === undefined
      ? null
      : String(row.last_vendor_commit),
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

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function contextUsage(value: unknown): ContextUsageRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const usage = value as Record<string, unknown>
  return {
    usedTokens: numberOrNull(usage.usedTokens),
    sizeTokens: numberOrNull(usage.sizeTokens),
    percentage: numberOrNull(usage.percentage),
    inputTokens: numberOrNull(usage.inputTokens),
    outputTokens: numberOrNull(usage.outputTokens),
    cacheReadTokens: numberOrNull(usage.cachedReadTokens ?? usage.cacheReadTokens),
    cacheWriteTokens: numberOrNull(usage.cachedWriteTokens ?? usage.cacheWriteTokens),
    totalTokens: numberOrNull(usage.totalTokens),
    updatedAt: typeof usage.updatedAt === 'string' ? usage.updatedAt : null,
  }
}

const contextCapabilityIds = new Set([
  'acp.listSessions',
  'acp.loadSession',
  'acp.unstable_forkSession',
  'acp.unstable_resumeSession',
  'command.local.compact',
  'command.local.rewind',
  'feature.CONTEXT_COLLAPSE',
  'feature.EXTRACT_MEMORIES',
  'feature.HISTORY_SNIP',
  'feature.LODESTONE',
  'feature.PROMPT_CACHE_BREAK_DETECTION',
  'feature.TEAMMEM',
  'feature.TOKEN_BUDGET',
  'tool.CtxInspectTool',
  'tool.LocalMemoryRecallTool',
  'tool.VaultHttpFetchTool',
])

const lifecycleBoundaries: DataLifecycleBoundary[] = [
  {
    dataClass: 'memory',
    sourceOfTruth: 'Agent state volume; DeepHarness persists source/status/result metadata only.',
    controlPlaneContent: 'metadata_only',
    backupScope: 'Back up the Agent state volume only when memory continuity is required.',
    deleteBoundary: 'Delete Agent memory at its vendor-owned store, then remove projected metadata with the session.',
  },
  {
    dataClass: 'transcript',
    sourceOfTruth: 'Vendor JSONL transcript in the Agent state volume.',
    controlPlaneContent: 'metadata_only',
    backupScope: 'Back up the Agent state volume together with vendor commit metadata.',
    deleteBoundary: 'Transcript deletion is a vendor session operation; database event deletion does not erase model context.',
  },
  {
    dataClass: 'artifact',
    sourceOfTruth: 'Workspace or future artifact volume; the database stores registry metadata.',
    controlPlaneContent: 'registry_only',
    backupScope: 'Back up artifact bytes and registry rows as one consistency set.',
    deleteBoundary: 'Delete registry metadata only after the workspace-bounded artifact bytes are removed.',
  },
  {
    dataClass: 'database_event',
    sourceOfTruth: 'PostgreSQL control-plane event log.',
    controlPlaneContent: 'full_event',
    backupScope: 'Use a PostgreSQL-consistent backup; Memory tool content is excluded before insertion.',
    deleteBoundary: 'Deleting a Harness session cascades control-plane events but does not delete vendor transcripts or workspace files.',
  },
]

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

function iso(value: unknown): string {
  return new Date(String(value)).toISOString()
}

function agentActivityFromRow(row: Record<string, unknown>): AgentActivityRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    vendorAgentId: row.vendor_agent_id === null ? null : String(row.vendor_agent_id),
    toolCallId: String(row.tool_call_id),
    parentAgentId: row.parent_agent_id === null ? null : String(row.parent_agent_id),
    parentToolCallId: row.parent_tool_call_id === null ? null : String(row.parent_tool_call_id),
    agentType: String(row.agent_type),
    name: row.name === null ? null : String(row.name),
    description: String(row.description),
    status: row.status as AgentActivityRecord['status'],
    runInBackground: row.run_in_background === true,
    permissionMode: String(row.permission_mode),
    workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
    totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
    totalDurationMs: row.total_duration_ms === null ? null : Number(row.total_duration_ms),
    totalToolUseCount: row.total_tool_use_count === null ? null : Number(row.total_tool_use_count),
    output: (row.output ?? null) as JsonValue,
    metadata: (row.metadata ?? {}) as Record<string, JsonValue>,
    startedAt: iso(row.started_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  }
}

function taskActivityFromRow(row: Record<string, unknown>): TaskActivityRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: row.turn_id === null ? null : String(row.turn_id),
    vendorTaskId: String(row.vendor_task_id),
    parentAgentId: row.parent_agent_id === null ? null : String(row.parent_agent_id),
    subject: String(row.subject),
    description: String(row.description),
    status: row.status as TaskActivityRecord['status'],
    owner: row.owner === null ? null : String(row.owner),
    blockedBy: Array.isArray(row.blocked_by) ? row.blocked_by.map(String) : [],
    blocks: Array.isArray(row.blocks) ? row.blocks.map(String) : [],
    taskType: row.task_type === null ? null : String(row.task_type),
    output: (row.output ?? null) as JsonValue,
    metadata: (row.metadata ?? {}) as Record<string, JsonValue>,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  }
}

function teamPeerFromRow(row: Record<string, unknown>): TeamPeerRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    teamId: String(row.team_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    name: String(row.name),
    role: String(row.role),
    status: String(row.status),
    address: row.address === null ? null : String(row.address),
    cwd: row.cwd === null ? null : String(row.cwd),
    pid: row.pid === null ? null : Number(row.pid),
    metadata: (row.metadata ?? {}) as Record<string, JsonValue>,
    updatedAt: iso(row.updated_at),
  }
}

function teamActivityFromRow(
  row: Record<string, unknown>,
  peers: TeamPeerRecord[],
): TeamActivityRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    name: String(row.name),
    description: String(row.description),
    status: row.status as TeamActivityRecord['status'],
    leadAgentId: row.lead_agent_id === null ? null : String(row.lead_agent_id),
    metadata: (row.metadata ?? {}) as Record<string, JsonValue>,
    peers,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
  }
}

function teamMessageFromRow(row: Record<string, unknown>): TeamMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    teamId: row.team_id === null ? null : String(row.team_id),
    sender: String(row.sender),
    recipient: String(row.recipient),
    messageType: String(row.message_type),
    content: (row.content ?? null) as JsonValue,
    summary: row.summary === null ? null : String(row.summary),
    deliveryStatus: String(row.delivery_status),
    metadata: (row.metadata ?? {}) as Record<string, JsonValue>,
    createdAt: iso(row.created_at),
  }
}

function availableCommandFromRow(row: Record<string, unknown>): AvailableCommand {
  return {
    name: String(row.name),
    description: String(row.description ?? ''),
    inputHint: row.input_hint === null ? null : String(row.input_hint),
    source: row.source as AvailableCommand['source'],
    commandType: row.command_type as AvailableCommand['commandType'],
    callable: row.available === true && row.user_invocable === true,
    blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason),
    updatedAt: iso(row.updated_at),
  }
}

function extensionAuditFromRow(row: Record<string, unknown>): ExtensionAuditRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    kind: row.kind as ExtensionAuditRecord['kind'],
    name: String(row.name),
    action: row.action as ExtensionAuditRecord['action'],
    restartRequired: row.restart_required === true,
    createdAt: iso(row.created_at),
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

  async getActivity(sessionId: string): Promise<SessionActivitySnapshot> {
    const [agentRows, taskRows, teamRows, peerRows, messageRows, definitionRows, sessionRows] =
      await Promise.all([
        this.database<Record<string, unknown>[]>`
          SELECT * FROM agent_activities WHERE session_id = ${sessionId}
          ORDER BY started_at ASC, id ASC
        `,
        this.database<Record<string, unknown>[]>`
          SELECT * FROM task_activities WHERE session_id = ${sessionId}
          ORDER BY created_at ASC, id ASC
        `,
        this.database<Record<string, unknown>[]>`
          SELECT * FROM team_activities WHERE session_id = ${sessionId}
          ORDER BY created_at ASC, id ASC
        `,
        this.database<Record<string, unknown>[]>`
          SELECT * FROM team_peers WHERE session_id = ${sessionId}
          ORDER BY team_id ASC, name ASC
        `,
        this.database<Record<string, unknown>[]>`
          SELECT * FROM team_messages WHERE session_id = ${sessionId}
          ORDER BY created_at ASC, id ASC
        `,
        this.database<Array<{
          id: string
          name: string
          enabled: boolean
          invocable: boolean | null
          tested: boolean
          matrix_class: string
          conditions: JsonValue[]
          known_gap: string | null
        }>>`
          SELECT capability.id, capability.name, capability.enabled, capability.invocable,
            capability.tested, capability.matrix_class, capability.conditions, capability.known_gap
          FROM capabilities capability
          JOIN capability_manifests manifest ON manifest.id = capability.manifest_id
          WHERE capability.kind = 'agent' AND manifest.status = 'ready'
            AND manifest.generated_at = (
              SELECT max(generated_at) FROM capability_manifests WHERE status = 'ready'
            )
          ORDER BY capability.name ASC
        `,
        this.database<{ context_state: Record<string, JsonValue> }[]>`
          SELECT context_state FROM sessions WHERE id = ${sessionId}
        `,
      ])
    const peers = peerRows.map(teamPeerFromRow)
    const definitions: AgentDefinitionSummary[] = definitionRows.map(row => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      invocable: row.invocable,
      tested: row.tested,
      matrixClass: row.matrix_class,
      conditions: row.conditions ?? [],
      knownGap: row.known_gap,
    }))
    const limitsValue = sessionRows[0]?.context_state?.activityLimits
    const limits = limitsValue && typeof limitsValue === 'object' && !Array.isArray(limitsValue)
      ? limitsValue as unknown as ActivityLimits
      : null
    return {
      agents: agentRows.map(agentActivityFromRow),
      tasks: taskRows.map(taskActivityFromRow),
      teams: teamRows.map(row => teamActivityFromRow(
        row,
        peers.filter(peer => peer.teamId === String(row.id)),
      )),
      messages: messageRows.map(teamMessageFromRow),
      definitions,
      limits,
    }
  }

  async getContext(sessionId: string): Promise<SessionContextSnapshot | null> {
    const sessions = await this.database<Record<string, unknown>[]>`
      SELECT * FROM sessions WHERE id = ${sessionId}
    `
    const session = sessions[0]
    if (!session) return null
    const [memoryRows, checkpointRows, capabilityRows] = await Promise.all([
      this.database<Record<string, unknown>[]>`
        SELECT * FROM memory_observations
        WHERE session_id = ${sessionId}
        ORDER BY updated_at DESC, tool_call_id ASC
      `,
      this.database<Record<string, unknown>[]>`
        SELECT * FROM context_checkpoints
        WHERE session_id = ${sessionId}
        ORDER BY created_at DESC, event_id DESC
      `,
      this.database<Array<{
        id: string
        name: string
        matrix_class: ContextCapabilityRecord['matrixClass']
        compiled: boolean
        enabled: boolean
        tested: boolean
        conditions: JsonValue[]
        known_gap: string | null
        last_test_result: ContextCapabilityRecord['lastTestResult']
      }>>`
        SELECT capability.id, capability.name, capability.matrix_class,
          capability.compiled, capability.enabled, capability.tested,
          capability.conditions, capability.known_gap, capability.last_test_result
        FROM capabilities capability
        JOIN capability_manifests manifest ON manifest.id = capability.manifest_id
        WHERE manifest.status = 'ready'
          AND manifest.generated_at = (
            SELECT max(generated_at) FROM capability_manifests WHERE status = 'ready'
          )
        ORDER BY capability.kind ASC, capability.name ASC
      `,
    ])
    const state = session.context_state && typeof session.context_state === 'object'
      ? session.context_state as Record<string, JsonValue>
      : {}
    const transcriptValue = state.transcript && typeof state.transcript === 'object'
      && !Array.isArray(state.transcript)
      ? state.transcript as Record<string, JsonValue>
      : null
    const transcript: SessionContextSnapshot['transcript'] = transcriptValue
      ? {
          recordCount: numberOrNull(transcriptValue.recordCount) ?? 0,
          userCheckpointCount: numberOrNull(transcriptValue.userCheckpointCount) ?? 0,
          compactCount: numberOrNull(transcriptValue.compactCount) ?? 0,
          lastUserMessageId: typeof transcriptValue.lastUserMessageId === 'string'
            ? transcriptValue.lastUserMessageId
            : null,
          latestCompactBoundaryId: typeof transcriptValue.latestCompactBoundaryId === 'string'
            ? transcriptValue.latestCompactBoundaryId
            : null,
          updatedAt: typeof transcriptValue.updatedAt === 'string' ? transcriptValue.updatedAt : null,
        }
      : null
    const memories: MemoryObservationRecord[] = memoryRows.map(row => ({
      sessionId: String(row.session_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      toolCallId: String(row.tool_call_id),
      toolName: String(row.tool_name),
      sourceType: row.source_type as MemoryObservationRecord['sourceType'],
      sourceLabel: String(row.source_label),
      operation: String(row.operation),
      status: String(row.status),
      hit: typeof row.hit === 'boolean' ? row.hit : null,
      itemCount: numberOrNull(row.item_count),
      bytes: numberOrNull(row.result_bytes),
      truncated: row.truncated === true,
      errorCode: row.error_code === null ? null : String(row.error_code),
      httpStatus: numberOrNull(row.http_status),
      contentRedacted: true,
      updatedAt: iso(row.updated_at),
    }))
    const checkpoints: ContextCheckpointRecord[] = checkpointRows.map(row => ({
      id: String(row.event_id),
      sessionId: String(row.session_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      kind: 'compact',
      trigger: row.trigger === 'manual' || row.trigger === 'auto' ? row.trigger : 'unknown',
      status: String(row.status),
      boundaryId: row.boundary_id === null ? null : String(row.boundary_id),
      preTokens: numberOrNull(row.pre_tokens),
      messagesSummarized: numberOrNull(row.messages_summarized),
      source: String(row.source),
      createdAt: iso(row.created_at),
    }))
    const capabilities: ContextCapabilityRecord[] = capabilityRows
      .filter(row => contextCapabilityIds.has(row.id))
      .map(row => {
        let capabilityState: ContextCapabilityRecord['state'] = 'not_observable'
        if (!row.compiled || !row.enabled) capabilityState = 'disabled'
        else if (row.matrix_class === 'C') capabilityState = 'blocked'
        else if (row.id === 'tool.VaultHttpFetchTool') capabilityState = 'conditional'
        else if ([
          'feature.EXTRACT_MEMORIES',
          'feature.LODESTONE',
          'feature.PROMPT_CACHE_BREAK_DETECTION',
          'feature.TOKEN_BUDGET',
        ].includes(row.id)) {
          capabilityState = 'kernel_managed'
        } else if (row.tested && row.last_test_result === 'passed') capabilityState = 'supported'
        const reason = row.known_gap
          ?? (!row.compiled ? 'Not compiled in the locked vendor build.' : null)
          ?? (!row.enabled ? `Disabled by ${row.conditions.join(', ') || 'runtime conditions'}.` : null)
          ?? (capabilityState === 'kernel_managed'
            ? 'Runs inside the vendor kernel without a dedicated ACP status event.'
            : capabilityState === 'not_observable'
              ? 'No evidence-backed ACP status is currently observable.'
              : null)
        return {
          id: row.id,
          name: row.name,
          matrixClass: row.matrix_class,
          compiled: row.compiled,
          enabled: row.enabled,
          tested: row.tested,
          lastTestResult: row.last_test_result,
          state: capabilityState,
          reason,
        }
      })
    const operations = state.operations && typeof state.operations === 'object'
      && !Array.isArray(state.operations)
      ? state.operations as Record<string, JsonValue>
      : {}
    const compatibility = state.compatibility && typeof state.compatibility === 'object'
      && !Array.isArray(state.compatibility)
      ? state.compatibility as Record<string, JsonValue>
      : {}
    return {
      sessionId,
      usage: contextUsage(state.usage),
      transcript,
      memories,
      checkpoints,
      capabilities,
      operations,
      compatibility,
      lifecycle: lifecycleBoundaries,
    }
  }

  async getExtensions(sessionId: string): Promise<SessionExtensionSnapshot | null> {
    if (!await this.getSession(sessionId)) return null
    const [commandRows, stateRows, auditRows, blockedRows] = await Promise.all([
      this.database<Record<string, unknown>[]>`
        SELECT * FROM available_commands WHERE session_id = ${sessionId}
        ORDER BY available DESC, user_invocable DESC, name ASC
      `,
      this.database<Record<string, unknown>[]>`
        SELECT * FROM session_extension_state WHERE session_id = ${sessionId}
      `,
      this.database<Record<string, unknown>[]>`
        SELECT * FROM extension_audit_logs WHERE session_id = ${sessionId}
        ORDER BY created_at DESC LIMIT 100
      `,
      this.database<Array<{
        name: string
        conditions: JsonValue[]
        known_gap: string | null
      }>>`
        SELECT capability.name, capability.conditions, capability.known_gap
        FROM capabilities capability
        JOIN capability_manifests manifest ON manifest.id = capability.manifest_id
        WHERE capability.kind = 'command' AND capability.advertised_by_acp = false
          AND manifest.status = 'ready'
          AND manifest.generated_at = (
            SELECT max(generated_at) FROM capability_manifests WHERE status = 'ready'
          )
        ORDER BY capability.name ASC
      `,
    ])
    const state = stateRows[0]
    const blocked: AvailableCommand[] = blockedRows.map(row => {
      const commandType = row.conditions.some(value => String(value) === 'command_type:local-jsx')
        ? 'local-jsx'
        : 'local'
      return {
        name: row.name,
        description: 'Vendor terminal command',
        inputHint: null,
        source: 'manifest',
        commandType,
        callable: false,
        blockedReason: row.known_gap
          ?? 'ACP available_commands_update only publishes prompt commands.',
        updatedAt: state ? iso(state.updated_at) : new Date(0).toISOString(),
      }
    })
    return {
      revision: Number(state?.revision ?? 0),
      commands: [...commandRows.map(availableCommandFromRow), ...blocked],
      extensions: Array.isArray(state?.extensions)
        ? state.extensions as ExtensionEntry[]
        : [],
      mcpServers: Array.isArray(state?.mcp_servers)
        ? state.mcp_servers as McpServerStatus[]
        : [],
      audits: auditRows.map(extensionAuditFromRow),
      sourceErrors: Array.isArray(state?.source_errors)
        ? state.source_errors.map(String)
        : [],
      updatedAt: state ? iso(state.updated_at) : null,
    }
  }

  async isPromptCommandAvailable(sessionId: string, name: string): Promise<boolean> {
    const rows = await this.database<{ available: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM available_commands
        WHERE session_id = ${sessionId} AND name = ${name}
          AND command_type = 'prompt' AND available = true AND user_invocable = true
      ) AS available
    `
    return rows[0]?.available === true
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
          fork_point_event_id, created_vendor_commit, last_vendor_commit
        ) VALUES (
          ${input.sessionId}, ${input.agentSessionId ?? null}, ${input.workspaceId},
          ${strategy === 'fork' ? 'Forked session' : 'New session'}, 'queued',
          ${input.permissionMode}, ${input.modelId}, 'queued', ${strategy},
          ${input.parentSessionId ?? null}, ${input.forkPointEventId ?? null},
          (SELECT vendor_commit FROM workers WHERE status = 'online' ORDER BY last_heartbeat_at DESC LIMIT 1),
          (SELECT vendor_commit FROM workers WHERE status = 'online' ORDER BY last_heartbeat_at DESC LIMIT 1)
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
        createdVendorCommit: rows[0].created_vendor_commit === null
          ? null
          : String(rows[0].created_vendor_commit),
        lastVendorCommit: rows[0].last_vendor_commit === null
          ? null
          : String(rows[0].last_vendor_commit),
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
          createdVendorCommit: session.created_vendor_commit === null
            ? null
            : String(session.created_vendor_commit),
          lastVendorCommit: session.last_vendor_commit === null
            ? null
            : String(session.last_vendor_commit),
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
        createdVendorCommit: session.created_vendor_commit === null
          ? null
          : String(session.created_vendor_commit),
        lastVendorCommit: session.last_vendor_commit === null
          ? null
          : String(session.last_vendor_commit),
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
      | 'refresh_extensions' | 'set_extension_enabled'
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

  async createActivityControl(input: {
    sessionId: string
    commandId: string
    idempotencyKey: string
    type: 'stop_agent' | 'stop_task'
    activityId: string
    vendorActivityId: string
    reason: string
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
      const sessions = await transaction<{ process_state: string; status: string }[]>`
        SELECT process_state, status FROM sessions WHERE id = ${input.sessionId} FOR UPDATE
      `
      if (!sessions[0]) throw new Error('SESSION_NOT_FOUND')
      if (sessions[0].process_state !== 'running') throw new Error('SESSION_PROCESS_STOPPED')

      let payload: Extract<WorkerCommand, { type: 'stop_agent' | 'stop_task' }>['payload']
      if (input.type === 'stop_agent') {
        const rows = await transaction<{ vendor_agent_id: string | null; status: string }[]>`
          SELECT vendor_agent_id, status FROM agent_activities
          WHERE session_id = ${input.sessionId} AND id = ${input.activityId} FOR UPDATE
        `
        if (!rows[0]) throw new Error('ACTIVITY_NOT_FOUND')
        if (!['starting', 'running', 'stopping'].includes(rows[0].status)) {
          throw new Error('ACTIVITY_NOT_RUNNING')
        }
        if (!rows[0].vendor_agent_id || rows[0].vendor_agent_id !== input.vendorActivityId) {
          throw new Error('ACTIVITY_VENDOR_ID_MISMATCH')
        }
        payload = {
          agentId: input.activityId,
          vendorAgentId: input.vendorActivityId,
          reason: input.reason,
        }
        await transaction`
          UPDATE agent_activities SET status = 'stopping', updated_at = now()
          WHERE session_id = ${input.sessionId} AND id = ${input.activityId}
        `
      } else {
        const rows = await transaction<{ vendor_task_id: string; status: string; task_type: string | null }[]>`
          SELECT vendor_task_id, status, task_type FROM task_activities
          WHERE session_id = ${input.sessionId} AND id = ${input.activityId} FOR UPDATE
        `
        if (!rows[0]) throw new Error('ACTIVITY_NOT_FOUND')
        if (!['pending', 'in_progress', 'stopping'].includes(rows[0].status)) {
          throw new Error('ACTIVITY_NOT_RUNNING')
        }
        if (!rows[0].task_type || rows[0].vendor_task_id !== input.vendorActivityId) {
          throw new Error('ACTIVITY_NOT_STOPPABLE')
        }
        payload = {
          taskId: input.activityId,
          vendorTaskId: input.vendorActivityId,
          reason: input.reason,
        }
        await transaction`
          UPDATE task_activities SET status = 'stopping', updated_at = now()
          WHERE session_id = ${input.sessionId} AND id = ${input.activityId}
        `
      }
      await this.insertCommand(transaction, {
        id: input.commandId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        type: input.type,
        payload,
      })
      await transaction`
        INSERT INTO audit_logs (id, action, resource_type, resource_id, metadata)
        VALUES (
          ${crypto.randomUUID()}, ${`${input.type}.requested`},
          ${input.type === 'stop_agent' ? 'agent_activity' : 'task_activity'},
          ${input.activityId},
          ${transaction.json({
            sessionId: input.sessionId,
            vendorActivityId: input.vendorActivityId,
            reason: input.reason,
            commandId: input.commandId,
          })}
        )
      `
      return {
        command: {
          id: input.commandId,
          sessionId: input.sessionId,
          type: input.type,
          payload,
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
          created_vendor_commit = COALESCE(created_vendor_commit, ${typeof event.payload.vendorCommit === 'string' ? event.payload.vendorCommit : null}),
          last_vendor_commit = COALESCE(${typeof event.payload.vendorCommit === 'string' ? event.payload.vendorCommit : null}, last_vendor_commit),
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
        UPDATE sessions SET context_state = context_state || ${this.database.json(event.payload)}, updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'context.usage_updated') {
      await this.database`
        UPDATE sessions SET context_state = jsonb_set(
          context_state,
          '{usage}',
          COALESCE(context_state->'usage', '{}'::jsonb) || ${this.database.json(event.payload)},
          true
        ), updated_at = now()
        WHERE id = ${event.sessionId}
      `
    }
    if (event.type === 'context.compacted') {
      const transcript = event.payload.transcript
      const transcriptValue = transcript && typeof transcript === 'object' && !Array.isArray(transcript)
        ? transcript
        : null
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO context_checkpoints (
            event_id, session_id, turn_id, kind, trigger, status, boundary_id,
            pre_tokens, messages_summarized, source, created_at
          ) VALUES (
            ${event.id}, ${event.sessionId}, ${event.turnId}, 'compact',
            ${String(event.payload.trigger ?? 'unknown')}, ${String(event.payload.status ?? 'observed')},
            ${typeof event.payload.boundaryId === 'string' ? event.payload.boundaryId : null},
            ${numberOrNull(event.payload.preTokens)},
            ${numberOrNull(event.payload.messagesSummarized)},
            ${String(event.payload.source ?? 'acp')}, ${new Date(event.timestamp)}
          ) ON CONFLICT (event_id) DO NOTHING
        `
        await transaction`
          UPDATE sessions SET context_state = jsonb_set(
            ${transcriptValue
              ? transaction`jsonb_set(context_state, '{transcript}', ${transaction.json(transcriptValue)}, true)`
              : transaction`context_state`},
            '{compact}', ${transaction.json(event.payload)}, true
          ), updated_at = now()
          WHERE id = ${event.sessionId}
        `
      })
    }
    if (event.type === 'memory.observed') {
      await this.database`
        INSERT INTO memory_observations (
          session_id, tool_call_id, last_event_id, turn_id, tool_name, source_type,
          source_label, operation, status, hit, item_count, result_bytes, truncated,
          error_code, http_status, content_redacted, updated_at
        ) VALUES (
          ${event.sessionId}, ${String(event.payload.toolCallId ?? event.id)}, ${event.id},
          ${event.turnId}, ${String(event.payload.toolName ?? 'Memory')},
          ${String(event.payload.sourceType ?? 'local_memory')},
          ${String(event.payload.sourceLabel ?? 'Memory')},
          ${String(event.payload.operation ?? 'unknown')}, ${String(event.payload.status ?? 'unknown')},
          ${typeof event.payload.hit === 'boolean' ? event.payload.hit : null},
          ${numberOrNull(event.payload.itemCount)}, ${numberOrNull(event.payload.bytes)},
          ${event.payload.truncated === true},
          ${typeof event.payload.errorCode === 'string' ? event.payload.errorCode : null},
          ${numberOrNull(event.payload.httpStatus)}, true, ${new Date(event.timestamp)}
        ) ON CONFLICT (session_id, tool_call_id) DO UPDATE SET
          last_event_id = EXCLUDED.last_event_id,
          turn_id = COALESCE(EXCLUDED.turn_id, memory_observations.turn_id),
          status = EXCLUDED.status,
          hit = COALESCE(EXCLUDED.hit, memory_observations.hit),
          item_count = COALESCE(EXCLUDED.item_count, memory_observations.item_count),
          result_bytes = COALESCE(EXCLUDED.result_bytes, memory_observations.result_bytes),
          truncated = EXCLUDED.truncated,
          error_code = COALESCE(EXCLUDED.error_code, memory_observations.error_code),
          http_status = COALESCE(EXCLUDED.http_status, memory_observations.http_status),
          content_redacted = true,
          updated_at = EXCLUDED.updated_at
      `
    }
    if (event.type === 'commands.updated') {
      const commands = Array.isArray(event.payload.commands) ? event.payload.commands : []
      await this.database.begin(async transaction => {
        await transaction`DELETE FROM available_commands WHERE session_id = ${event.sessionId}`
        for (const value of commands) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const command = value as Record<string, JsonValue>
          if (typeof command.name !== 'string') continue
          await transaction`
            INSERT INTO available_commands (
              session_id, name, description, input_hint, source, command_type,
              user_invocable, available, blocked_reason, updated_at
            ) VALUES (
              ${event.sessionId}, ${command.name}, ${String(command.description ?? '')},
              ${typeof command.inputHint === 'string' ? command.inputHint : null},
              ${String(command.source ?? 'acp')}, ${String(command.commandType ?? 'prompt')},
              ${command.callable !== false}, ${true},
              ${typeof command.blockedReason === 'string' ? command.blockedReason : null},
              ${new Date(event.timestamp)}
            )
          `
        }
      })
    }
    if (event.type === 'extensions.updated') {
      const extensions = Array.isArray(event.payload.extensions) ? event.payload.extensions : []
      const mcpServers = Array.isArray(event.payload.mcpServers) ? event.payload.mcpServers : []
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO session_extension_state (
            session_id, revision, extensions, mcp_servers, source_errors, updated_at
          ) VALUES (
            ${event.sessionId}, ${typeof event.payload.revision === 'number' ? event.payload.revision : 0},
            ${transaction.json(extensions)}, ${transaction.json(mcpServers)},
            ${transaction.json(event.payload.sourceErrors ?? [])}, ${new Date(event.timestamp)}
          )
          ON CONFLICT (session_id) DO UPDATE SET
            revision = GREATEST(session_extension_state.revision, EXCLUDED.revision),
            extensions = EXCLUDED.extensions,
            mcp_servers = EXCLUDED.mcp_servers,
            source_errors = EXCLUDED.source_errors,
            updated_at = EXCLUDED.updated_at
        `
        await transaction`
          DELETE FROM integrations
          WHERE kind IN ('mcp', 'skill', 'plugin', 'hook')
            AND config_redacted->>'sessionId' = ${event.sessionId}
        `
        for (const value of [...extensions, ...mcpServers]) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const integration = value as Record<string, JsonValue>
          const kind = typeof integration.kind === 'string' ? integration.kind : 'mcp'
          if (!['mcp', 'skill', 'plugin', 'hook'].includes(kind)) continue
          const name = String(integration.name ?? 'unknown')
          const status = String(integration.status ?? integration.health ?? 'unknown')
          await transaction`
            INSERT INTO integrations (
              id, kind, name, enabled, config_redacted, credential_status,
              health_status, capabilities, last_checked_at
            ) VALUES (
              ${`${kind}:${event.sessionId}:${name}`}, ${kind}, ${name},
              ${integration.enabled === true},
              ${transaction.json({
                sessionId: event.sessionId,
                source: integration.source ?? 'project',
                path: integration.path ?? null,
                transport: integration.transport ?? null,
                endpoint: integration.endpoint ?? null,
                credentialValuesProjected: false,
              })},
              ${String(integration.authStatus ?? 'not_applicable')}, ${status},
              ${transaction.json({
                supportsTools: integration.supportsTools ?? null,
                supportsResources: integration.supportsResources ?? null,
                resourceCount: Array.isArray(integration.resources) ? integration.resources.length : 0,
              })}, ${new Date(event.timestamp)}
            )
          `
        }
      })
    }
    if (event.type === 'extension.configuration_changed') {
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO extension_audit_logs (
            id, session_id, kind, name, action, restart_required, created_at
          ) VALUES (
            ${event.id}, ${event.sessionId}, ${String(event.payload.kind ?? 'plugin')},
            ${String(event.payload.name ?? 'unknown')},
            ${String(event.payload.action ?? 'disabled')},
            ${event.payload.restartRequired !== false}, ${new Date(event.timestamp)}
          ) ON CONFLICT (id) DO NOTHING
        `
        await transaction`
          INSERT INTO audit_logs (id, action, resource_type, resource_id, metadata)
          VALUES (
            ${crypto.randomUUID()}, 'extension.configuration_changed',
            ${String(event.payload.kind ?? 'extension')}, ${String(event.payload.name ?? 'unknown')},
            ${transaction.json({
              sessionId: event.sessionId,
              enabled: event.payload.enabled ?? false,
              restartRequired: event.payload.restartRequired ?? true,
              settingsSource: event.payload.settingsSource ?? 'local',
              eventId: event.id,
            })}
          )
        `
      })
    }
    if (event.type === 'session.closed') {
      await this.database.begin(async transaction => {
        await transaction`
          UPDATE sessions SET status = 'closed', process_state = 'stopped', closed_at = now(),
            active_turn_id = NULL, updated_at = now() WHERE id = ${event.sessionId}
        `
        await transaction`
          UPDATE agent_activities SET status = 'stopped', completed_at = COALESCE(completed_at, now()),
            updated_at = now(), metadata = metadata || '{"stopReason":"session_closed"}'::jsonb
          WHERE session_id = ${event.sessionId} AND status IN ('starting', 'running', 'stopping')
        `
        await transaction`
          UPDATE task_activities SET status = 'stopped', completed_at = COALESCE(completed_at, now()),
            updated_at = now(), metadata = metadata || '{"stopReason":"session_closed"}'::jsonb
          WHERE session_id = ${event.sessionId} AND task_type IS NOT NULL
            AND status IN ('pending', 'in_progress', 'stopping')
        `
        await transaction`
          UPDATE team_peers SET status = 'stopped', updated_at = now(),
            metadata = metadata || '{"stopReason":"session_closed"}'::jsonb
          WHERE session_id = ${event.sessionId}
            AND status IN ('active', 'online', 'starting', 'running', 'stopping')
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
    if (event.type === 'agent.started' || event.type === 'agent.updated' || event.type === 'agent.completed') {
      const id = String(event.payload.id ?? event.payload.toolCallId ?? event.id)
      const completed = event.type === 'agent.completed'
        || ['completed', 'failed', 'stopped', 'interrupted', 'quota_exceeded'].includes(String(event.payload.status))
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO agent_activities (
            id, session_id, turn_id, vendor_agent_id, tool_call_id, parent_agent_id,
            parent_tool_call_id, agent_type, name, description, status,
            run_in_background, permission_mode, workspace_path, total_tokens,
            total_duration_ms, total_tool_use_count, output, metadata, started_at,
            updated_at, completed_at
          ) VALUES (
            ${id}, ${event.sessionId}, ${event.turnId},
            ${typeof event.payload.vendorAgentId === 'string' ? event.payload.vendorAgentId : null},
            ${String(event.payload.toolCallId ?? id)},
            ${typeof event.payload.parentAgentId === 'string' ? event.payload.parentAgentId : null},
            ${typeof event.payload.parentToolCallId === 'string' ? event.payload.parentToolCallId : null},
            ${String(event.payload.agentType ?? 'unknown')},
            ${typeof event.payload.name === 'string' ? event.payload.name : null},
            ${String(event.payload.description ?? '')}, ${String(event.payload.status ?? 'running')},
            ${event.payload.runInBackground === true},
            ${String(event.payload.permissionMode ?? 'default')},
            ${typeof event.payload.workspacePath === 'string' ? event.payload.workspacePath : null},
            ${typeof event.payload.totalTokens === 'number' ? event.payload.totalTokens : null},
            ${typeof event.payload.totalDurationMs === 'number' ? event.payload.totalDurationMs : null},
            ${typeof event.payload.totalToolUseCount === 'number' ? event.payload.totalToolUseCount : null},
            COALESCE(${transaction.json(event.payload.output ?? null)}, 'null'::jsonb),
            ${transaction.json(event.payload.metadata ?? {})},
            ${new Date(String(event.payload.startedAt ?? event.timestamp))}, now(),
            ${completed ? new Date(event.timestamp) : null}
          )
          ON CONFLICT (session_id, id) DO UPDATE SET
            turn_id = COALESCE(EXCLUDED.turn_id, agent_activities.turn_id),
            vendor_agent_id = COALESCE(EXCLUDED.vendor_agent_id, agent_activities.vendor_agent_id),
            parent_agent_id = COALESCE(EXCLUDED.parent_agent_id, agent_activities.parent_agent_id),
            parent_tool_call_id = COALESCE(EXCLUDED.parent_tool_call_id, agent_activities.parent_tool_call_id),
            agent_type = CASE WHEN EXCLUDED.agent_type = 'unknown' THEN agent_activities.agent_type ELSE EXCLUDED.agent_type END,
            name = COALESCE(EXCLUDED.name, agent_activities.name),
            description = CASE WHEN EXCLUDED.description = '' THEN agent_activities.description ELSE EXCLUDED.description END,
            status = EXCLUDED.status,
            run_in_background = EXCLUDED.run_in_background,
            permission_mode = EXCLUDED.permission_mode,
            workspace_path = COALESCE(EXCLUDED.workspace_path, agent_activities.workspace_path),
            total_tokens = COALESCE(EXCLUDED.total_tokens, agent_activities.total_tokens),
            total_duration_ms = COALESCE(EXCLUDED.total_duration_ms, agent_activities.total_duration_ms),
            total_tool_use_count = COALESCE(EXCLUDED.total_tool_use_count, agent_activities.total_tool_use_count),
            output = CASE WHEN EXCLUDED.output = 'null'::jsonb THEN agent_activities.output ELSE EXCLUDED.output END,
            metadata = agent_activities.metadata || EXCLUDED.metadata,
            updated_at = now(),
            completed_at = COALESCE(EXCLUDED.completed_at, agent_activities.completed_at)
        `
        const metadata = event.payload.metadata
        const activityLimits = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? (metadata as Record<string, JsonValue>).activityLimits
          : null
        if (activityLimits && typeof activityLimits === 'object' && !Array.isArray(activityLimits)) {
          await transaction`
            UPDATE sessions SET
              context_state = jsonb_set(context_state, '{activityLimits}', ${transaction.json(activityLimits)}),
              updated_at = now()
            WHERE id = ${event.sessionId}
          `
        }
      })
    }
    if (event.type === 'task.created' || event.type === 'task.updated' || event.type === 'task.output_delta') {
      const id = String(event.payload.id ?? event.payload.taskId ?? event.payload.vendorTaskId ?? event.id)
      const vendorTaskId = String(event.payload.vendorTaskId ?? event.payload.taskId ?? id)
      const status = String(event.payload.status ?? 'unknown')
      const completed = ['completed', 'failed', 'stopped', 'deleted'].includes(status)
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO task_activities (
            id, session_id, turn_id, vendor_task_id, parent_agent_id, subject,
            description, status, owner, blocked_by, blocks, task_type, output,
            metadata, created_at, updated_at, completed_at
          ) VALUES (
            ${id}, ${event.sessionId}, ${event.turnId}, ${vendorTaskId},
            ${typeof event.payload.parentAgentId === 'string' ? event.payload.parentAgentId : null},
            ${String(event.payload.subject ?? '')}, ${String(event.payload.description ?? '')},
            ${status}, ${typeof event.payload.owner === 'string' ? event.payload.owner : null},
            ${transaction.json(event.payload.blockedBy ?? [])},
            ${transaction.json(event.payload.blocks ?? [])},
            ${typeof event.payload.taskType === 'string' ? event.payload.taskType : null},
            COALESCE(${transaction.json(event.payload.output ?? null)}, 'null'::jsonb),
            ${transaction.json(event.payload.metadata ?? {})},
            ${new Date(String(event.payload.createdAt ?? event.timestamp))}, now(),
            ${completed ? new Date(event.timestamp) : null}
          )
          ON CONFLICT (session_id, id) DO UPDATE SET
            turn_id = COALESCE(EXCLUDED.turn_id, task_activities.turn_id),
            parent_agent_id = COALESCE(EXCLUDED.parent_agent_id, task_activities.parent_agent_id),
            subject = CASE WHEN EXCLUDED.subject = '' THEN task_activities.subject ELSE EXCLUDED.subject END,
            description = CASE WHEN EXCLUDED.description = '' THEN task_activities.description ELSE EXCLUDED.description END,
            status = CASE WHEN EXCLUDED.status = 'unknown' THEN task_activities.status ELSE EXCLUDED.status END,
            owner = COALESCE(EXCLUDED.owner, task_activities.owner),
            blocked_by = CASE WHEN EXCLUDED.blocked_by = '[]'::jsonb THEN task_activities.blocked_by ELSE EXCLUDED.blocked_by END,
            blocks = CASE WHEN EXCLUDED.blocks = '[]'::jsonb THEN task_activities.blocks ELSE EXCLUDED.blocks END,
            task_type = COALESCE(EXCLUDED.task_type, task_activities.task_type),
            output = CASE WHEN EXCLUDED.output = 'null'::jsonb THEN task_activities.output ELSE EXCLUDED.output END,
            metadata = task_activities.metadata || EXCLUDED.metadata,
            updated_at = now(),
            completed_at = COALESCE(EXCLUDED.completed_at, task_activities.completed_at)
        `
        if (event.type === 'task.output_delta' && event.payload.output !== undefined) {
          await transaction`
            INSERT INTO task_output_chunks (event_id, session_id, task_id, content, created_at)
            VALUES (
              ${event.id}, ${event.sessionId}, ${id},
              COALESCE(${transaction.json(event.payload.output)}, 'null'::jsonb), ${new Date(event.timestamp)}
            ) ON CONFLICT (event_id) DO NOTHING
          `
        }
      })
    }
    if (event.type === 'team.updated') {
      const id = String(event.payload.id ?? event.payload.teamId ?? event.payload.name ?? event.id)
      const status = String(event.payload.status ?? 'active')
      const peers = Array.isArray(event.payload.peers) ? event.payload.peers : []
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO team_activities (
            id, session_id, name, description, status, lead_agent_id, metadata,
            created_at, updated_at, deleted_at
          ) VALUES (
            ${id}, ${event.sessionId}, ${String(event.payload.name ?? id)},
            ${String(event.payload.description ?? '')}, ${status},
            ${typeof event.payload.leadAgentId === 'string' ? event.payload.leadAgentId : null},
            ${transaction.json(event.payload.metadata ?? {})},
            ${new Date(String(event.payload.createdAt ?? event.timestamp))}, now(),
            ${status === 'deleted' ? new Date(event.timestamp) : null}
          )
          ON CONFLICT (session_id, id) DO UPDATE SET
            name = EXCLUDED.name,
            description = CASE WHEN EXCLUDED.description = '' THEN team_activities.description ELSE EXCLUDED.description END,
            status = EXCLUDED.status,
            lead_agent_id = COALESCE(EXCLUDED.lead_agent_id, team_activities.lead_agent_id),
            metadata = team_activities.metadata || EXCLUDED.metadata,
            updated_at = now(),
            deleted_at = CASE
              WHEN EXCLUDED.status = 'deleted'
                THEN COALESCE(EXCLUDED.deleted_at, team_activities.deleted_at)
              ELSE NULL
            END
        `
        for (const value of peers) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue
          const peer = value as Record<string, JsonValue>
          const peerId = String(peer.id ?? peer.agentId ?? peer.address ?? peer.name ?? crypto.randomUUID())
          await transaction`
            INSERT INTO team_peers (
              id, session_id, team_id, agent_id, name, role, status, address,
              cwd, pid, metadata, updated_at
            ) VALUES (
              ${peerId}, ${event.sessionId}, ${id},
              ${typeof peer.agentId === 'string' ? peer.agentId : null},
              ${String(peer.name ?? peerId)}, ${String(peer.role ?? 'peer')},
              ${String(peer.status ?? 'unknown')},
              ${typeof peer.address === 'string' ? peer.address : null},
              ${typeof peer.cwd === 'string' ? peer.cwd : null},
              ${typeof peer.pid === 'number' ? peer.pid : null},
              ${transaction.json(peer.metadata ?? {})}, now()
            )
            ON CONFLICT (session_id, team_id, id) DO UPDATE SET
              agent_id = COALESCE(EXCLUDED.agent_id, team_peers.agent_id),
              name = EXCLUDED.name, role = EXCLUDED.role, status = EXCLUDED.status,
              address = COALESCE(EXCLUDED.address, team_peers.address),
              cwd = COALESCE(EXCLUDED.cwd, team_peers.cwd),
              pid = COALESCE(EXCLUDED.pid, team_peers.pid),
              metadata = team_peers.metadata || EXCLUDED.metadata,
              updated_at = now()
          `
        }
      })
    }
    if (event.type === 'team.message') {
      const teamId = typeof event.payload.teamId === 'string' ? event.payload.teamId : null
      await this.database.begin(async transaction => {
        await transaction`
          INSERT INTO team_messages (
            id, session_id, team_id, sender, recipient, message_type, content,
            summary, delivery_status, metadata, created_at
          ) VALUES (
            ${event.id}, ${event.sessionId}, ${teamId},
            ${String(event.payload.sender ?? 'unknown')},
            ${String(event.payload.recipient ?? 'unknown')},
            ${String(event.payload.messageType ?? 'message')},
            COALESCE(${transaction.json(event.payload.content ?? null)}, 'null'::jsonb),
            ${typeof event.payload.summary === 'string' ? event.payload.summary : null},
            ${String(event.payload.deliveryStatus ?? 'unknown')},
            ${transaction.json(event.payload.metadata ?? {})}, ${new Date(event.timestamp)}
          ) ON CONFLICT (id) DO NOTHING
        `
        await transaction`
          INSERT INTO audit_logs (id, action, resource_type, resource_id, metadata)
          VALUES (
            ${crypto.randomUUID()}, 'team.message', 'session', ${event.sessionId},
            ${transaction.json({
              sender: event.payload.sender ?? 'unknown',
              recipient: event.payload.recipient ?? 'unknown',
              teamId,
              deliveryStatus: event.payload.deliveryStatus ?? 'unknown',
              eventId: event.id,
            })}
          )
        `
      })
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
