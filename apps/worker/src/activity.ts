import type {
  ActivityLimits,
  AgentActivityStatus,
  HarnessEvent,
  JsonValue,
  TaskActivityStatus,
} from '@deepharness/protocol'
import path from 'node:path'
import type { PersistedActivityState } from './activityState.ts'

type Emit = (
  type: HarnessEvent['type'],
  payload: Record<string, JsonValue>,
  turnId: string | null,
) => void

export interface ToolObservation {
  toolCallId: string
  toolName: string
  status: string
  rawInput: Record<string, JsonValue>
  rawOutput?: JsonValue
  parentToolUseId: string | null
  turnId: string | null
}

interface ToolState extends ToolObservation {}

interface AgentState {
  id: string
  vendorAgentId: string | null
  toolCallId: string
  parentAgentId: string | null
  parentToolCallId: string | null
  agentType: string
  name: string | null
  description: string
  status: AgentActivityStatus
  runInBackground: boolean
  permissionMode: string
  workspacePath: string | null
  totalTokens: number | null
  totalDurationMs: number | null
  totalToolUseCount: number | null
  output: JsonValue
  outputText: string
  turnId: string | null
  startedAt: string
}

interface TaskState {
  id: string
  vendorTaskId: string
  parentAgentId: string | null
  subject: string
  description: string
  status: TaskActivityStatus
  owner: string | null
  blockedBy: string[]
  blocks: string[]
  taskType: string | null
  output: JsonValue
  metadata: Record<string, JsonValue>
  turnId: string | null
  createdAt: string
}

interface TeamPeer {
  id: string
  agentId: string | null
  name: string
  role: string
  status: string
  address: string | null
  cwd: string | null
  pid: number | null
  metadata: Record<string, JsonValue>
}

interface TeamState {
  id: string
  name: string
  description: string
  status: 'active' | 'deleting' | 'deleted' | 'error'
  leadAgentId: string | null
  peers: Map<string, TeamPeer>
  createdAt: string
}

export interface ActivityTrackerOptions {
  permissionMode: string
  workspacePath: string
  maxActiveAgents: number
  maxAgentDepth: number
  maxTeamPeers: number
  maxAgentTokens: number
  emit: Emit
  onPolicyViolation: (reason: string) => void
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function objectValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? jsonValue(value) as Record<string, JsonValue>
    : {}
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item
      const record = objectValue(item)
      return typeof record.text === 'string' ? record.text : ''
    }).filter(Boolean).join('\n')
  }
  const record = objectValue(value)
  if (typeof record.text === 'string') return record.text
  if (record.content !== undefined) return textValue(record.content)
  return ''
}

function structuredOutput(value: unknown): Record<string, JsonValue> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return objectValue(value)
  const text = textValue(value).trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return objectValue(parsed)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return objectValue(JSON.parse(text.slice(start, end + 1)))
      } catch {
        return {}
      }
    }
    return {}
  }
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function taskStatus(value: unknown): TaskActivityStatus {
  const status = String(value ?? 'unknown')
  return [
    'pending', 'in_progress', 'completed', 'failed', 'stopping', 'stopped', 'deleted',
  ].includes(status) ? status as TaskActivityStatus : 'unknown'
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null
}

export class ActivityTracker {
  private readonly tools = new Map<string, ToolState>()
  private readonly agents = new Map<string, AgentState>()
  private readonly agentByToolCall = new Map<string, string>()
  private readonly tasks = new Map<string, TaskState>()
  private readonly teams = new Map<string, TeamState>()
  private readonly reconciledToolResults = new Set<string>()
  private readonly reconciledAgentNotifications = new Set<string>()
  private readonly persistedTaskIds = new Map<string, Set<string>>()
  private readonly preStopAgentStatuses = new Map<string, AgentActivityStatus>()
  private readonly preStopTaskStatuses = new Map<string, TaskActivityStatus>()
  private currentTeamId: string | null = null
  private observedAgentTokens = 0

  constructor(private readonly options: ActivityTrackerOptions) {}

  setPermissionMode(permissionMode: string): void {
    this.options.permissionMode = permissionMode
  }

  get hasActiveAgents(): boolean {
    return [...this.agents.values()].some(agent =>
      ['starting', 'running', 'stopping'].includes(agent.status),
    )
  }

  get limits(): ActivityLimits {
    return {
      maxActiveAgents: this.options.maxActiveAgents,
      maxAgentDepth: this.options.maxAgentDepth,
      maxTeamPeers: this.options.maxTeamPeers,
      maxAgentTokens: this.options.maxAgentTokens,
      activeAgents: [...this.agents.values()].filter(agent =>
        ['starting', 'running', 'stopping'].includes(agent.status),
      ).length,
      observedAgentTokens: this.observedAgentTokens,
    }
  }

  parentAgentId(parentToolUseId: string | null): string | null {
    return parentToolUseId ? this.agentByToolCall.get(parentToolUseId) ?? null : null
  }

  agentForId(agentId: string): AgentState | null {
    const direct = this.agents.get(agentId)
    if (direct) return direct
    return [...this.agents.values()].find(agent => agent.vendorAgentId === agentId) ?? null
  }

  private agentSubtree(rootAgentId: string): AgentState[] {
    const result: AgentState[] = []
    const pending = [rootAgentId]
    while (pending.length > 0) {
      const id = pending.shift()!
      const agent = this.agents.get(id)
      if (agent) result.push(agent)
      for (const child of this.agents.values()) {
        if (child.parentAgentId === id) pending.push(child.id)
      }
    }
    return result
  }

  requestAgentStop(agentId: string): AgentState | null {
    const agent = this.agentForId(agentId)
    if (!agent || !['starting', 'running'].includes(agent.status)) return null
    for (const member of this.agentSubtree(agent.id)) {
      if (!['starting', 'running'].includes(member.status)) continue
      this.preStopAgentStatuses.set(member.id, member.status)
      member.status = 'stopping'
      this.emitAgent('agent.updated', member, {
        stopReason: 'user_requested',
        stopRootAgentId: agent.id,
      })
    }
    return agent
  }

  requestTaskStop(taskId: string): TaskState | null {
    const task = this.tasks.get(taskId)
      ?? [...this.tasks.values()].find(candidate => candidate.vendorTaskId === taskId)
      ?? null
    if (!task || !['pending', 'in_progress'].includes(task.status)) return null
    this.preStopTaskStatuses.set(task.id, task.status)
    task.status = 'stopping'
    this.emitTask('task.updated', task, { stopReason: 'user_requested' })
    return task
  }

  controlFailed(kind: 'agent' | 'task', id: string, message: string): void {
    if (kind === 'agent') {
      const agent = this.agentForId(id)
      if (!agent) return
      for (const member of this.agentSubtree(agent.id)) {
        const priorStatus = this.preStopAgentStatuses.get(member.id)
        if (!priorStatus) continue
        this.preStopAgentStatuses.delete(member.id)
        member.status = priorStatus
        this.emitAgent('agent.updated', member, {
          controlError: message,
          stopRootAgentId: agent.id,
        })
      }
      return
    }
    const task = this.tasks.get(id)
      ?? [...this.tasks.values()].find(candidate => candidate.vendorTaskId === id)
    if (!task) return
    task.status = this.preStopTaskStatuses.get(task.id) ?? 'in_progress'
    this.preStopTaskStatuses.delete(task.id)
    this.emitTask('task.updated', task, { controlError: message })
  }

  isStopping(kind: 'agent' | 'task', id: string): boolean {
    if (kind === 'agent') return this.agentForId(id)?.status === 'stopping'
    const task = this.tasks.get(id)
      ?? [...this.tasks.values()].find(candidate => candidate.vendorTaskId === id)
    return task?.status === 'stopping'
  }

  observeChunk(
    parentToolUseId: string | null,
    kind: 'text' | 'reasoning',
    text: string,
  ): boolean {
    const agentId = this.parentAgentId(parentToolUseId)
    if (!agentId) return false
    const agent = this.agents.get(agentId)
    if (!agent) return false
    agent.outputText += text
    agent.output = agent.outputText
    this.emitAgent('agent.updated', agent, {
      outputDelta: text,
      outputKind: kind,
    })
    return true
  }

  observeTool(observation: ToolObservation): {
    parentAgentId: string | null
    toolName: string
    rawInput: Record<string, JsonValue>
    rawOutput?: JsonValue
  } {
    const previous = this.tools.get(observation.toolCallId)
    const rawOutput = observation.rawOutput ?? previous?.rawOutput
    const merged: ToolState = {
      ...observation,
      rawInput: {
        ...(previous?.rawInput ?? {}),
        ...observation.rawInput,
      },
      ...(rawOutput !== undefined ? { rawOutput } : {}),
      parentToolUseId: observation.parentToolUseId ?? previous?.parentToolUseId ?? null,
      turnId: observation.turnId ?? previous?.turnId ?? null,
    }
    this.tools.set(observation.toolCallId, merged)
    const logical = this.logicalTool(merged)
    const parentAgentId = this.parentAgentId(logical.parentToolUseId)

    if (/^(?:Agent|Task)$/i.test(logical.toolName)) this.observeAgentTool(logical, parentAgentId)
    else if (/^Task(?:Create|Get|List|Update|Output|Stop)$/i.test(logical.toolName)) {
      this.observeTaskTool(logical, parentAgentId)
    } else if (/^(?:TeamCreate|TeamDelete|SendMessage|ListPeers)$/i.test(logical.toolName)) {
      this.observeTeamTool(logical, parentAgentId)
    }

    if (parentAgentId && !/^(?:Agent|Task)$/i.test(logical.toolName)) {
      const parent = this.agents.get(parentAgentId)
      if (parent) {
        this.emitAgent('agent.updated', parent, {
          lastToolCall: {
            toolCallId: logical.toolCallId,
            toolName: logical.toolName,
            status: logical.status,
            rawInput: logical.rawInput,
            ...(logical.rawOutput !== undefined ? { rawOutput: logical.rawOutput } : {}),
          },
        })
      }
    }
    return {
      parentAgentId,
      toolName: logical.toolName,
      rawInput: logical.rawInput,
      ...(logical.rawOutput !== undefined ? { rawOutput: logical.rawOutput } : {}),
    }
  }

  private logicalTool(tool: ToolState): ToolState {
    if (tool.toolName.toLowerCase() !== 'executeextratool') return tool
    const logicalName = tool.rawInput.tool_name
    if (typeof logicalName !== 'string') return tool
    const output = objectValue(tool.rawOutput)
    const logicalOutput = output.tool_name === logicalName && output.result !== undefined
      ? output.result
      : tool.rawOutput
    return {
      ...tool,
      toolName: logicalName,
      rawInput: objectValue(tool.rawInput.params),
      ...(logicalOutput !== undefined ? { rawOutput: logicalOutput } : {}),
    }
  }

  resync(turnId: string | null): void {
    for (const agent of this.agents.values()) {
      this.emitAgent('agent.updated', { ...agent, turnId: agent.turnId ?? turnId }, {
        resync: true,
      })
    }
    for (const task of this.tasks.values()) this.emitTask('task.updated', task, { resync: true })
    for (const team of this.teams.values()) this.emitTeam(team, { resync: true })
  }

  closeActive(reason: string): void {
    for (const agent of this.agents.values()) {
      if (!['starting', 'running', 'stopping'].includes(agent.status)) continue
      agent.status = 'stopped'
      this.preStopAgentStatuses.delete(agent.id)
      this.emitAgent('agent.completed', agent, { stopReason: reason })
    }

    for (const task of this.tasks.values()) {
      const processBacked = task.taskType !== null
      if (!processBacked || !['pending', 'in_progress', 'stopping'].includes(task.status)) continue
      task.status = 'stopped'
      this.preStopTaskStatuses.delete(task.id)
      this.emitTask('task.updated', task, { stopReason: reason })
    }

    for (const team of this.teams.values()) {
      let changed = false
      for (const peer of team.peers.values()) {
        if (!['active', 'online', 'starting', 'running', 'stopping'].includes(peer.status)) continue
        peer.status = 'stopped'
        changed = true
      }
      if (changed) this.emitTeam(team, { stopReason: reason })
    }
  }

  reconcile(snapshot: PersistedActivityState, turnId: string | null): Set<string> {
    const reconciled = new Set<string>()
    for (const result of snapshot.toolResults) {
      const tool = this.tools.get(result.toolCallId)
      if (!tool || this.reconciledToolResults.has(result.toolCallId)) continue
      this.reconciledToolResults.add(result.toolCallId)
      reconciled.add(result.toolCallId)
      this.observeTool({
        ...tool,
        status: result.failed ? 'failed' : 'completed',
        rawOutput: result.output,
        turnId: tool.turnId ?? turnId,
      })
    }

    for (const notification of snapshot.agentNotifications) {
      const notificationId = `${notification.toolCallId}:${notification.status}`
      if (this.reconciledAgentNotifications.has(notificationId)) continue
      const agent = this.agentForId(notification.agentId)
        ?? this.agentForId(notification.toolCallId)
      if (!agent) continue
      this.reconciledAgentNotifications.add(notificationId)
      const priorTotalTokens = agent.totalTokens ?? 0
      agent.vendorAgentId = notification.agentId
      agent.status = notification.status
      agent.totalTokens = notification.totalTokens
      agent.totalDurationMs = notification.totalDurationMs
      agent.totalToolUseCount = notification.totalToolUseCount
      agent.output = {
        status: notification.status,
        summary: notification.summary,
        result: notification.result,
        totalTokens: notification.totalTokens,
        totalDurationMs: notification.totalDurationMs,
        totalToolUseCount: notification.totalToolUseCount,
      }
      if (agent.totalTokens !== null) {
        this.observedAgentTokens += Math.max(0, agent.totalTokens - priorTotalTokens)
      }
      this.emitAgent('agent.completed', agent, {
        source: 'vendor_transcript',
        reconciled: true,
        notification: 'task-notification',
      })
    }

    const activeTaskLists = new Set(snapshot.scannedTaskLists)
    for (const [taskListId, taskIds] of this.persistedTaskIds) {
      if (activeTaskLists.has(taskListId)) continue
      for (const taskId of taskIds) {
        const task = this.tasks.get(taskId)
        if (!task || task.status === 'deleted') continue
        task.status = 'deleted'
        this.emitTask('task.updated', task, {
          source: 'vendor_state',
          reconciled: true,
          taskListInactive: true,
        })
      }
      this.persistedTaskIds.delete(taskListId)
    }
    for (const taskListId of snapshot.scannedTaskLists) {
      const persisted = snapshot.tasks.filter(task => task.taskListId === taskListId)
      const currentIds = new Set(persisted.map(task => task.id))
      const previousIds = this.persistedTaskIds.get(taskListId) ?? new Set<string>()
      for (const task of persisted) {
        const exists = this.tasks.has(task.id)
        const next = this.upsertTask(task.id, {
          subject: task.subject,
          description: task.description,
          status: task.status,
          owner: task.owner,
          blockedBy: task.blockedBy,
          blocks: task.blocks,
          metadata: {
            ...task.metadata,
            source: 'vendor_state',
            taskListId,
          },
          turnId,
        })
        this.emitTask(exists ? 'task.updated' : 'task.created', next, {
          source: 'vendor_state',
          reconciled: true,
        })
      }
      for (const removedId of previousIds) {
        if (currentIds.has(removedId)) continue
        const removed = this.tasks.get(removedId)
        if (!removed || removed.status === 'deleted') continue
        removed.status = 'deleted'
        this.emitTask('task.updated', removed, {
          source: 'vendor_state',
          reconciled: true,
        })
      }
      this.persistedTaskIds.set(taskListId, currentIds)
    }

    const currentTeamIds = new Set(snapshot.teams.map(team => team.id))
    for (const persisted of snapshot.teams) {
      const current = this.teams.get(persisted.id)
      const team: TeamState = {
        id: persisted.id,
        name: persisted.name,
        description: persisted.description,
        status: 'active',
        leadAgentId: persisted.leadAgentId,
        peers: new Map(persisted.peers.map(peer => [peer.id, {
          id: peer.id,
          agentId: peer.agentId,
          name: peer.name,
          role: peer.role,
          status: peer.status,
          address: peer.address,
          cwd: peer.cwd,
          pid: peer.pid,
          metadata: peer.metadata,
        }])),
        createdAt: current?.createdAt ?? persisted.createdAt,
      }
      this.teams.set(team.id, team)
      this.currentTeamId = team.id
      this.emitTeam(team, { source: 'vendor_state', reconciled: true })
      for (const peer of persisted.peers) {
        const agent = this.agentForId(peer.agentId)
          ?? [...this.agents.values()].find(candidate => candidate.name === peer.name)
        if (!agent) continue
        agent.vendorAgentId = peer.agentId
        this.emitAgent('agent.updated', agent, {
          source: 'vendor_state',
          peerStatus: peer.status,
        })
      }
    }
    if (snapshot.teamScanComplete) {
      for (const team of this.teams.values()) {
        if (currentTeamIds.has(team.id) || team.status === 'deleted') continue
        team.status = 'deleted'
        this.emitTeam(team, { source: 'vendor_state', reconciled: true })
        if (this.currentTeamId === team.id) this.currentTeamId = null
      }
    }
    return reconciled
  }

  private observeAgentTool(tool: ToolState, parentAgentId: string | null): void {
    let agent = this.agents.get(tool.toolCallId)
    let created = false
    if (!agent) {
      const now = new Date().toISOString()
      agent = {
        id: tool.toolCallId,
        vendorAgentId: null,
        toolCallId: tool.toolCallId,
        parentAgentId,
        parentToolCallId: tool.parentToolUseId,
        agentType: String(tool.rawInput.subagent_type ?? 'general-purpose'),
        name: typeof tool.rawInput.name === 'string' ? tool.rawInput.name : null,
        description: String(tool.rawInput.description ?? ''),
        status: 'starting',
        runInBackground: tool.rawInput.run_in_background === true,
        permissionMode: typeof tool.rawInput.mode === 'string'
          ? tool.rawInput.mode
          : this.options.permissionMode,
        workspacePath: typeof tool.rawInput.cwd === 'string'
          ? tool.rawInput.cwd
          : this.options.workspacePath,
        totalTokens: null,
        totalDurationMs: null,
        totalToolUseCount: null,
        output: null,
        outputText: '',
        turnId: tool.turnId,
        startedAt: now,
      }
      this.agents.set(agent.id, agent)
      this.agentByToolCall.set(agent.toolCallId, agent.id)
      created = true
    }

    agent.parentAgentId = parentAgentId ?? agent.parentAgentId
    agent.parentToolCallId = tool.parentToolUseId ?? agent.parentToolCallId
    if (typeof tool.rawInput.subagent_type === 'string') agent.agentType = tool.rawInput.subagent_type
    if (typeof tool.rawInput.name === 'string') agent.name = tool.rawInput.name
    if (typeof tool.rawInput.description === 'string') agent.description = tool.rawInput.description
    if (typeof tool.rawInput.run_in_background === 'boolean') {
      agent.runInBackground = tool.rawInput.run_in_background
    }
    if (typeof tool.rawInput.mode === 'string') agent.permissionMode = tool.rawInput.mode
    if (typeof tool.rawInput.cwd === 'string') agent.workspacePath = tool.rawInput.cwd
    agent.turnId ??= tool.turnId

    if (created) {
      const violation = this.agentPolicyViolation(agent)
      if (violation) {
        agent.status = 'quota_exceeded'
        this.emitAgent('agent.started', agent, { policyViolation: violation })
        this.emitAgent('agent.completed', agent, { policyViolation: violation })
        this.options.onPolicyViolation(violation)
        return
      }
      this.emitAgent('agent.started', agent)
    } else if (['starting', 'running'].includes(agent.status)) {
      const violation = this.agentPolicyViolation(agent)
      if (violation) {
        agent.status = 'quota_exceeded'
        this.emitAgent('agent.completed', agent, { policyViolation: violation })
        this.options.onPolicyViolation(violation)
        return
      }
    }

    if (agent.status === 'quota_exceeded') return
    if (tool.status === 'completed' || tool.status === 'failed') {
      const output = structuredOutput(tool.rawOutput)
      const outputText = textValue(tool.rawOutput)
      const vendorAgentId = String(
        output.agentId
          ?? output.agent_id
          ?? output.teammate_id
          ?? outputText.match(/agentId:\s*([^\s)]+)/i)?.[1]
          ?? '',
      ) || null
      const priorTotalTokens = agent.totalTokens ?? 0
      const totalTokens = safeInteger(output.totalTokens)
        ?? safeInteger(output.total_tokens)
        ?? safeInteger(outputText.match(/total_tokens:\s*(\d+)/i)?.[1] ? Number(outputText.match(/total_tokens:\s*(\d+)/i)?.[1]) : null)
      if (vendorAgentId) agent.vendorAgentId = vendorAgentId
      agent.output = tool.rawOutput ?? null
      agent.totalTokens = totalTokens
      agent.totalDurationMs = safeInteger(output.totalDurationMs)
      agent.totalToolUseCount = safeInteger(output.totalToolUseCount)
      agent.runInBackground = output.status === 'async_launched' || agent.runInBackground
      const launched = output.status === 'async_launched'
        || output.status === 'teammate_spawned'
        || output.status === 'remote_launched'
      agent.status = tool.status === 'failed' ? 'failed' : launched ? 'running' : 'completed'
      if (agent.totalTokens !== null) {
        this.observedAgentTokens += Math.max(0, agent.totalTokens - priorTotalTokens)
      }
      this.emitAgent(launched ? 'agent.updated' : 'agent.completed', agent)
      this.observeTeammateSpawn(tool, agent, output)
      return
    }
    if (tool.status === 'in_progress' && agent.status === 'starting') {
      agent.status = 'running'
      this.emitAgent('agent.updated', agent)
    }
  }

  private agentPolicyViolation(agent: AgentState): string | null {
    const active = [...this.agents.values()].filter(candidate =>
      candidate.id !== agent.id && ['starting', 'running', 'stopping'].includes(candidate.status),
    ).length
    if (active >= this.options.maxActiveAgents) {
      return `SUBAGENT_CONCURRENCY_LIMIT:${this.options.maxActiveAgents}`
    }
    let depth = 1
    let parentId = agent.parentAgentId
    const seen = new Set<string>()
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      depth += 1
      parentId = this.agents.get(parentId)?.parentAgentId ?? null
    }
    if (depth > this.options.maxAgentDepth) {
      return `SUBAGENT_DEPTH_LIMIT:${this.options.maxAgentDepth}`
    }
    if (this.observedAgentTokens >= this.options.maxAgentTokens) {
      return `SUBAGENT_TOKEN_LIMIT:${this.options.maxAgentTokens}`
    }
    if (this.permissionExpansion(agent)) {
      return `SUBAGENT_PERMISSION_EXPANSION:${this.options.permissionMode}->${agent.permissionMode}`
    }
    if (agent.workspacePath && !this.insideWorkspace(agent.workspacePath)) {
      return `SUBAGENT_WORKSPACE_BOUNDARY:${agent.workspacePath}`
    }
    const peerCount = [...this.teams.values()].reduce((sum, team) => sum + team.peers.size, 0)
    if (agent.name && peerCount >= this.options.maxTeamPeers) {
      return `TEAM_PEER_LIMIT:${this.options.maxTeamPeers}`
    }
    return null
  }

  private permissionExpansion(agent: AgentState): boolean {
    const parentMode = this.options.permissionMode
    const childMode = agent.permissionMode
    if (['bypassPermissions', 'acceptEdits', 'auto'].includes(parentMode)) return false
    const builtIn = [
      'Explore',
      'Plan',
      'general-purpose',
      'verification',
      'claude-code-guide',
      'statusline-setup',
    ].includes(agent.agentType)
    if (!builtIn) return true
    if (childMode === parentMode) return false
    if (parentMode === 'default') return !['plan', 'dontAsk'].includes(childMode)
    if (parentMode === 'dontAsk') return childMode !== 'plan'
    return true
  }

  private insideWorkspace(candidate: string): boolean {
    const root = path.resolve(this.options.workspacePath)
    const resolved = path.resolve(candidate)
    const relative = path.relative(root, resolved)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  }

  private observeTaskTool(tool: ToolState, parentAgentId: string | null): void {
    if (tool.status !== 'completed' && tool.status !== 'failed' && tool.rawOutput === undefined) return
    const input = tool.rawInput
    const output = structuredOutput(tool.rawOutput)
    const text = textValue(tool.rawOutput)
    const name = tool.toolName.toLowerCase()

    if (name === 'taskcreate' && tool.status === 'completed') {
      const vendorTaskId = String(
        objectValue(output.task).id
          ?? text.match(/Task #([^\s]+) created successfully/i)?.[1]
          ?? tool.toolCallId,
      )
      const task = this.upsertTask(vendorTaskId, {
        parentAgentId,
        subject: String(input.subject ?? text.match(/successfully:\s*(.+)$/i)?.[1] ?? ''),
        description: String(input.description ?? ''),
        status: 'pending',
        metadata: objectValue(input.metadata),
        turnId: tool.turnId,
      })
      this.emitTask('task.created', task)
      return
    }

    if (name === 'tasklist' && tool.status === 'completed') {
      for (const line of text.split('\n')) {
        const match = line.match(/^#(\S+) \[([^\]]+)] (.*?)(?: \(([^)]+)\))?(?: \[blocked by (.+)])?$/)
        if (!match) continue
        const task = this.upsertTask(match[1]!, {
          subject: match[3] ?? '',
          status: taskStatus(match[2]),
          owner: match[4] ?? null,
          blockedBy: match[5]?.match(/#([^,\s]+)/g)?.map(value => value.slice(1)) ?? [],
          parentAgentId,
          turnId: tool.turnId,
        })
        this.emitTask('task.updated', task, { sourceTool: 'TaskList' })
      }
      return
    }

    const vendorTaskId = String(input.taskId ?? input.task_id ?? input.shell_id ?? '')
    if (!vendorTaskId) return

    if (name === 'taskget' && tool.status === 'completed') {
      const task = this.upsertTask(vendorTaskId, {
        subject: text.match(/^Task #[^:]+:\s*(.+)$/m)?.[1] ?? '',
        description: text.match(/^Description:\s*(.*)$/m)?.[1] ?? '',
        status: taskStatus(text.match(/^Status:\s*(\S+)/m)?.[1]),
        blockedBy: text.match(/^Blocked by:\s*(.*)$/m)?.[1]?.match(/#([^,\s]+)/g)?.map(value => value.slice(1)) ?? [],
        blocks: text.match(/^Blocks:\s*(.*)$/m)?.[1]?.match(/#([^,\s]+)/g)?.map(value => value.slice(1)) ?? [],
        parentAgentId,
        turnId: tool.turnId,
      })
      this.emitTask('task.updated', task, { sourceTool: 'TaskGet' })
      return
    }

    if (name === 'taskupdate' && tool.status === 'completed') {
      const updatedStatus = input.status ?? objectValue(output.statusChange).to
      const task = this.upsertTask(vendorTaskId, {
        ...(typeof input.subject === 'string' ? { subject: input.subject } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(updatedStatus !== undefined ? { status: taskStatus(updatedStatus) } : {}),
        ...(typeof input.owner === 'string' ? { owner: input.owner } : {}),
        ...(Array.isArray(input.addBlockedBy) ? { blockedBy: stringArray(input.addBlockedBy) } : {}),
        ...(Array.isArray(input.addBlocks) ? { blocks: stringArray(input.addBlocks) } : {}),
        ...(input.metadata !== undefined ? { metadata: objectValue(input.metadata) } : {}),
        parentAgentId,
        turnId: tool.turnId,
      })
      this.emitTask('task.updated', task, { sourceTool: 'TaskUpdate' })
      return
    }

    if (name === 'taskoutput') {
      const taskData = objectValue(output.task)
      const task = this.upsertTask(vendorTaskId, {
        ...(typeof taskData.description === 'string' ? { description: taskData.description } : {}),
        ...(taskData.status !== undefined ? { status: taskStatus(taskData.status) } : {}),
        ...(typeof taskData.task_type === 'string' ? { taskType: taskData.task_type } : {}),
        output: taskData.output ?? taskData.result ?? tool.rawOutput ?? null,
        parentAgentId,
        turnId: tool.turnId,
      })
      this.emitTask('task.output_delta', task, {
        output: task.output,
        retrievalStatus: output.retrieval_status ?? 'unknown',
      })
      return
    }

    if (name === 'taskstop' && tool.status === 'completed') {
      const task = this.upsertTask(vendorTaskId, {
        status: 'stopped',
        ...(typeof output.task_type === 'string' ? { taskType: output.task_type } : {}),
        output: output.message ?? tool.rawOutput ?? null,
        parentAgentId,
        turnId: tool.turnId,
      })
      this.emitTask('task.updated', task, { sourceTool: 'TaskStop' })
      this.preStopTaskStatuses.delete(task.id)
      const agent = this.agentForId(vendorTaskId)
      if (agent) {
        for (const member of this.agentSubtree(agent.id)) {
          this.preStopAgentStatuses.delete(member.id)
          if (!['starting', 'running', 'stopping'].includes(member.status)) continue
          member.status = 'stopped'
          this.emitAgent('agent.completed', member, {
            stopReason: 'TaskStop',
            stopRootAgentId: agent.id,
          })
        }
      }
    }
  }

  private observeTeamTool(tool: ToolState, parentAgentId: string | null): void {
    if (tool.status !== 'completed' && tool.status !== 'failed') return
    const output = structuredOutput(tool.rawOutput)
    const text = textValue(tool.rawOutput)
    const input = tool.rawInput
    const name = tool.toolName.toLowerCase()

    if (name === 'teamcreate') {
      const teamName = String(output.team_name ?? input.team_name ?? 'team')
      const team: TeamState = {
        id: teamName,
        name: teamName,
        description: String(input.description ?? ''),
        status: tool.status === 'failed' ? 'error' : 'active',
        leadAgentId: typeof output.lead_agent_id === 'string' ? output.lead_agent_id : null,
        peers: new Map(),
        createdAt: new Date().toISOString(),
      }
      if (team.leadAgentId) {
        team.peers.set(team.leadAgentId, {
          id: team.leadAgentId,
          agentId: team.leadAgentId,
          name: 'team-lead',
          role: 'lead',
          status: 'active',
          address: null,
          cwd: this.options.workspacePath,
          pid: null,
          metadata: {},
        })
      }
      this.teams.set(team.id, team)
      this.currentTeamId = team.id
      this.emitTeam(team, { sourceTool: 'TeamCreate', rawOutput: tool.rawOutput ?? null })
      return
    }

    if (name === 'teamdelete') {
      const teamId = String(output.team_name ?? this.currentTeamId ?? input.team_name ?? 'team')
      const team = this.teams.get(teamId) ?? {
        id: teamId,
        name: teamId,
        description: '',
        status: 'active' as const,
        leadAgentId: null,
        peers: new Map<string, TeamPeer>(),
        createdAt: new Date().toISOString(),
      }
      team.status = tool.status === 'failed' || output.success === false ? 'error' : 'deleted'
      this.teams.set(team.id, team)
      this.emitTeam(team, { sourceTool: 'TeamDelete', rawOutput: tool.rawOutput ?? null })
      if (team.status === 'deleted' && this.currentTeamId === team.id) this.currentTeamId = null
      return
    }

    if (name === 'sendmessage') {
      const message = input.message ?? input.content ?? ''
      const messageObject = objectValue(message)
      const parent = parentAgentId ? this.agents.get(parentAgentId) : null
      this.options.emit('team.message', {
        teamId: this.currentTeamId,
        sender: parent?.name ?? parent?.vendorAgentId ?? parent?.id ?? 'team-lead',
        recipient: String(input.to ?? input.recipient ?? 'unknown'),
        messageType: typeof messageObject.type === 'string' ? messageObject.type : 'message',
        content: jsonValue(message),
        summary: typeof input.summary === 'string' ? input.summary : null,
        deliveryStatus: tool.status === 'failed' || output.success === false ? 'failed' : 'delivered',
        metadata: {
          toolCallId: tool.toolCallId,
          parentAgentId,
          vendorMessage: output.message ?? text,
        },
      }, tool.turnId)
      return
    }

    if (name === 'listpeers') {
      if (tool.status === 'failed') return
      const teamId = this.currentTeamId ?? 'cross-session-peers'
      const team = this.teams.get(teamId) ?? {
        id: teamId,
        name: teamId,
        description: 'ACP peer discovery',
        status: 'active' as const,
        leadAgentId: null,
        peers: new Map<string, TeamPeer>(),
        createdAt: new Date().toISOString(),
      }
      const peers = Array.isArray(output.peers) ? output.peers.map(objectValue) : []
      if (peers.length === 0) {
        for (const line of text.split('\n').slice(1)) {
          const match = line.trim().match(/^(\S+)(?: \(([^)]+)\))?(?: @ (.+))?$/)
          if (match) peers.push({ address: match[1]!, name: match[2] ?? match[1]!, cwd: match[3] ?? null })
        }
      }
      for (const peer of peers) {
        const id = String(peer.address ?? peer.name ?? `${teamId}:unnamed-peer`)
        team.peers.set(id, {
          id,
          agentId: null,
          name: String(peer.name ?? id),
          role: 'peer',
          status: 'online',
          address: typeof peer.address === 'string' ? peer.address : null,
          cwd: typeof peer.cwd === 'string' ? peer.cwd : null,
          pid: safeInteger(peer.pid),
          metadata: {},
        })
      }
      this.teams.set(team.id, team)
      this.emitTeam(team, { sourceTool: 'ListPeers' })
    }
  }

  private observeTeammateSpawn(
    tool: ToolState,
    agent: AgentState,
    output: Record<string, JsonValue>,
  ): void {
    const teamId = String(output.team_name ?? tool.rawInput.team_name ?? this.currentTeamId ?? '')
    const name = String(output.name ?? tool.rawInput.name ?? '')
    if (!teamId || !name) return
    const team = this.teams.get(teamId) ?? {
      id: teamId,
      name: teamId,
      description: '',
      status: 'active' as const,
      leadAgentId: null,
      peers: new Map<string, TeamPeer>(),
      createdAt: new Date().toISOString(),
    }
    const vendorAgentId = agent.vendorAgentId ?? String(output.agent_id ?? output.teammate_id ?? agent.id)
    team.peers.set(vendorAgentId, {
      id: vendorAgentId,
      agentId: vendorAgentId,
      name,
      role: String(output.agent_type ?? agent.agentType),
      status: tool.status === 'failed' ? 'failed' : 'active',
      address: null,
      cwd: agent.workspacePath,
      pid: null,
      metadata: { color: output.color ?? null },
    })
    this.teams.set(team.id, team)
    this.currentTeamId = team.id
    this.emitTeam(team, { sourceTool: 'Agent' })
  }

  private upsertTask(
    vendorTaskId: string,
    update: Partial<Omit<TaskState, 'id' | 'vendorTaskId' | 'createdAt'>>,
  ): TaskState {
    const current = this.tasks.get(vendorTaskId) ?? {
      id: vendorTaskId,
      vendorTaskId,
      parentAgentId: null,
      subject: '',
      description: '',
      status: 'unknown' as const,
      owner: null,
      blockedBy: [],
      blocks: [],
      taskType: null,
      output: null,
      metadata: {},
      turnId: null,
      createdAt: new Date().toISOString(),
    }
    const next: TaskState = {
      ...current,
      ...update,
      blockedBy: update.blockedBy?.length ? update.blockedBy : current.blockedBy,
      blocks: update.blocks?.length ? update.blocks : current.blocks,
      metadata: { ...current.metadata, ...(update.metadata ?? {}) },
    }
    this.tasks.set(vendorTaskId, next)
    return next
  }

  private emitAgent(
    type: 'agent.started' | 'agent.updated' | 'agent.completed',
    agent: AgentState,
    metadata: Record<string, JsonValue> = {},
  ): void {
    this.options.emit(type, {
      id: agent.id,
      vendorAgentId: agent.vendorAgentId,
      toolCallId: agent.toolCallId,
      parentAgentId: agent.parentAgentId,
      parentToolCallId: agent.parentToolCallId,
      agentType: agent.agentType,
      name: agent.name,
      description: agent.description,
      status: agent.status,
      runInBackground: agent.runInBackground,
      permissionMode: agent.permissionMode,
      workspacePath: agent.workspacePath,
      totalTokens: agent.totalTokens,
      totalDurationMs: agent.totalDurationMs,
      totalToolUseCount: agent.totalToolUseCount,
      output: agent.output,
      startedAt: agent.startedAt,
      metadata: {
        ...metadata,
        activityLimits: jsonValue(this.limits),
      },
    }, agent.turnId)
  }

  private emitTask(
    type: 'task.created' | 'task.updated' | 'task.output_delta',
    task: TaskState,
    metadata: Record<string, JsonValue> = {},
  ): void {
    this.options.emit(type, {
      id: task.id,
      vendorTaskId: task.vendorTaskId,
      parentAgentId: task.parentAgentId,
      subject: task.subject,
      description: task.description,
      status: task.status,
      owner: task.owner,
      blockedBy: task.blockedBy,
      blocks: task.blocks,
      taskType: task.taskType,
      output: task.output,
      createdAt: task.createdAt,
      metadata: { ...task.metadata, ...metadata },
    }, task.turnId)
  }

  private emitTeam(team: TeamState, metadata: Record<string, JsonValue> = {}): void {
    this.options.emit('team.updated', {
      id: team.id,
      name: team.name,
      description: team.description,
      status: team.status,
      leadAgentId: team.leadAgentId,
      peers: [...team.peers.values()].map(peer => jsonValue(peer)),
      createdAt: team.createdAt,
      metadata,
    }, null)
  }
}
