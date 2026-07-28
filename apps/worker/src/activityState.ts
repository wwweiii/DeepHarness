import type { JsonValue, TaskActivityStatus } from '@deepharness/protocol'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { findTranscript } from './transcript.ts'

const maxStateFileBytes = 2 * 1024 * 1024

export interface PersistedToolResult {
  toolCallId: string
  output: JsonValue
  failed: boolean
}

export interface PersistedAgentNotification {
  agentId: string
  toolCallId: string
  status: 'completed' | 'failed' | 'stopped' | 'interrupted'
  summary: string
  result: string
  totalTokens: number | null
  totalDurationMs: number | null
  totalToolUseCount: number | null
}

export interface PersistedTaskState {
  taskListId: string
  id: string
  subject: string
  description: string
  status: TaskActivityStatus
  owner: string | null
  blockedBy: string[]
  blocks: string[]
  metadata: Record<string, JsonValue>
}

export interface PersistedTeamPeer {
  id: string
  agentId: string
  name: string
  role: string
  status: string
  address: string
  cwd: string | null
  pid: number | null
  metadata: Record<string, JsonValue>
}

export interface PersistedTeamState {
  id: string
  name: string
  description: string
  leadAgentId: string | null
  createdAt: string
  peers: PersistedTeamPeer[]
}

export interface PersistedActivityState {
  toolResults: PersistedToolResult[]
  agentNotifications: PersistedAgentNotification[]
  tasks: PersistedTaskState[]
  teams: PersistedTeamState[]
  scannedTaskLists: string[]
  teamScanComplete: boolean
}

export interface ActivityStateOptions {
  configDir?: string
  transcriptPath?: string | null
}

function configHome(options: ActivityStateOptions): string {
  return path.resolve(
    options.configDir
      ?? process.env.CLAUDE_CONFIG_DIR
      ?? path.join(process.env.HOME ?? '/home/agent', '.claude'),
  )
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
}

function taskStatus(value: unknown): TaskActivityStatus {
  const status = String(value ?? 'unknown')
  if (status === 'in_progress') return status
  if (['pending', 'completed', 'failed', 'stopping', 'stopped', 'deleted'].includes(status)) {
    return status as TaskActivityStatus
  }
  if (status === 'killed') return 'stopped'
  return 'unknown'
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== 'number' && typeof value !== 'string') return new Date().toISOString()
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.valueOf()) ? new Date().toISOString() : timestamp.toISOString()
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const file = await stat(filePath)
    if (!file.isFile() || file.size > maxStateFileBytes) return null
    return objectValue(JSON.parse(await readFile(filePath, 'utf8')))
  } catch {
    return null
  }
}

async function readJsonArrayFile(filePath: string): Promise<unknown[]> {
  try {
    const file = await stat(filePath)
    if (!file.isFile() || file.size > maxStateFileBytes) return []
    const value = JSON.parse(await readFile(filePath, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function toolResultId(record: Record<string, unknown>): { id: string; failed: boolean } | null {
  const message = objectValue(record.message)
  const content = Array.isArray(message.content) ? message.content : []
  for (const item of content) {
    const block = objectValue(item)
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      return { id: block.tool_use_id, failed: block.is_error === true }
    }
  }
  return null
}

function contentOutput(record: Record<string, unknown>): JsonValue {
  if (record.toolUseResult !== undefined) return jsonValue(record.toolUseResult)
  const message = objectValue(record.message)
  const content = Array.isArray(message.content) ? message.content : []
  const texts = content.flatMap(item => {
    const block = objectValue(item)
    if (block.type !== 'tool_result') return []
    if (typeof block.content === 'string') return [block.content]
    if (!Array.isArray(block.content)) return []
    return block.content.flatMap(part => {
      const contentPart = objectValue(part)
      return contentPart.type === 'text' && typeof contentPart.text === 'string'
        ? [contentPart.text]
        : []
    })
  })
  return texts.join('\n')
}

function notificationTag(content: string, tag: string): string {
  const match = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))
  return match?.[1]?.trim() ?? ''
}

function agentNotification(record: Record<string, unknown>): PersistedAgentNotification | null {
  if (record.type !== 'queue-operation' || typeof record.content !== 'string') return null
  const content = record.content
  if (!content.includes('<task-notification>')) return null
  const agentId = notificationTag(content, 'task-id')
  const toolCallId = notificationTag(content, 'tool-use-id')
  const rawStatus = notificationTag(content, 'status')
  if (!agentId || !toolCallId || !rawStatus) return null
  const status = rawStatus === 'completed'
    ? 'completed'
    : rawStatus === 'stopped' || rawStatus === 'killed'
      ? 'stopped'
      : rawStatus === 'interrupted'
        ? 'interrupted'
        : 'failed'
  const usage = notificationTag(content, 'usage')
  const integer = (tag: string): number | null => {
    const value = notificationTag(usage, tag)
    return /^\d+$/.test(value) ? Number.parseInt(value, 10) : null
  }
  return {
    agentId,
    toolCallId,
    status,
    summary: notificationTag(content, 'summary'),
    result: notificationTag(content, 'result'),
    totalTokens: integer('total_tokens'),
    totalDurationMs: integer('duration_ms'),
    totalToolUseCount: integer('tool_uses'),
  }
}

async function readTranscriptState(transcriptPath: string | null): Promise<{
  toolResults: PersistedToolResult[]
  agentNotifications: PersistedAgentNotification[]
}> {
  if (!transcriptPath) return { toolResults: [], agentNotifications: [] }
  const results = new Map<string, PersistedToolResult>()
  const notifications = new Map<string, PersistedAgentNotification>()
  let precedingToolResultId: string | null = null
  try {
    const lines = createInterface({
      input: createReadStream(transcriptPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of lines) {
      if (!line.trim()) continue
      let record: Record<string, unknown>
      try {
        record = objectValue(JSON.parse(line))
      } catch {
        continue
      }
      const notification = agentNotification(record)
      if (notification) {
        notifications.set(`${notification.toolCallId}:${notification.status}`, notification)
        precedingToolResultId = null
        continue
      }
      const result = toolResultId(record)
      if (result) {
        results.set(result.id, {
          toolCallId: result.id,
          output: contentOutput(record),
          failed: result.failed,
        })
        precedingToolResultId = result.id
        continue
      }
      const message = objectValue(record.message)
      const content = typeof message.content === 'string' ? message.content : ''
      if (precedingToolResultId && /Tool "[^"]+" (?:not found|has not been discovered)/i.test(content)) {
        results.set(precedingToolResultId, {
          toolCallId: precedingToolResultId,
          output: content,
          failed: true,
        })
      }
      precedingToolResultId = null
    }
  } catch {
    return { toolResults: [], agentNotifications: [] }
  }
  return {
    toolResults: [...results.values()],
    agentNotifications: [...notifications.values()],
  }
}

async function readTeams(
  root: string,
  vendorSessionId: string,
): Promise<{ teams: PersistedTeamState[]; complete: boolean }> {
  const teamsRoot = path.join(root, 'teams')
  let entries
  try {
    entries = await readdir(teamsRoot, { withFileTypes: true })
  } catch (error) {
    const code = objectValue(error).code
    return { teams: [], complete: code === 'ENOENT' }
  }
  const teams: PersistedTeamState[] = []
  for (const entry of entries.slice(0, 256)) {
    if (!entry.isDirectory()) continue
    const value = await readJsonFile(path.join(teamsRoot, entry.name, 'config.json'))
    if (!value || value.leadSessionId !== vendorSessionId) continue
    const name = typeof value.name === 'string' ? value.name : entry.name
    const leadAgentId = typeof value.leadAgentId === 'string' ? value.leadAgentId : null
    const shutdownApprovals = new Map<string, Record<string, JsonValue>>()
    const leadInbox = await readJsonArrayFile(
      path.join(teamsRoot, entry.name, 'inboxes', 'team-lead.json'),
    )
    for (const messageValue of leadInbox.slice(-1_000)) {
      const message = objectValue(messageValue)
      if (typeof message.text !== 'string') continue
      let protocol: Record<string, unknown>
      try {
        protocol = objectValue(JSON.parse(message.text))
      } catch {
        continue
      }
      if (protocol.type !== 'shutdown_approved' || typeof protocol.from !== 'string') continue
      shutdownApprovals.set(protocol.from, jsonValue({
        requestId: protocol.requestId ?? null,
        timestamp: protocol.timestamp ?? message.timestamp ?? null,
        backendType: protocol.backendType ?? null,
        paneId: protocol.paneId ?? null,
      }) as Record<string, JsonValue>)
    }
    const peers = (Array.isArray(value.members) ? value.members : []).flatMap(memberValue => {
      const member = objectValue(memberValue)
      if (typeof member.agentId !== 'string' || typeof member.name !== 'string') return []
      const role = member.agentId === leadAgentId ? 'lead' : String(member.agentType ?? 'peer')
      const shutdownApproval = shutdownApprovals.get(member.name)
      return [{
        id: member.agentId,
        agentId: member.agentId,
        name: member.name,
        role,
        status: member.isActive === false ? 'idle' : 'active',
        address: `${member.name}@${name}`,
        cwd: typeof member.cwd === 'string' ? member.cwd : null,
        pid: safeInteger(member.pid),
        metadata: jsonValue({
          backendType: member.backendType ?? null,
          model: member.model ?? null,
          sessionId: member.sessionId ?? null,
          subscriptions: stringArray(member.subscriptions),
          ...(shutdownApproval ? { shutdownApproval } : {}),
        }) as Record<string, JsonValue>,
      }]
    })
    teams.push({
      id: name,
      name,
      description: typeof value.description === 'string' ? value.description : '',
      leadAgentId,
      createdAt: safeTimestamp(value.createdAt),
      peers,
    })
  }
  return { teams, complete: true }
}

async function readTasks(root: string, taskListIds: string[]): Promise<PersistedTaskState[]> {
  const tasks: PersistedTaskState[] = []
  for (const taskListId of taskListIds) {
    const listRoot = path.join(root, 'tasks', taskListId.replace(/[^a-zA-Z0-9_-]/g, '-'))
    let entries
    try {
      entries = await readdir(listRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.slice(0, 2048)) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
      const value = await readJsonFile(path.join(listRoot, entry.name))
      if (!value || typeof value.id !== 'string') continue
      tasks.push({
        taskListId,
        id: value.id,
        subject: typeof value.subject === 'string' ? value.subject : '',
        description: typeof value.description === 'string' ? value.description : '',
        status: taskStatus(value.status),
        owner: typeof value.owner === 'string' ? value.owner : null,
        blockedBy: stringArray(value.blockedBy),
        blocks: stringArray(value.blocks),
        metadata: jsonValue(objectValue(value.metadata)) as Record<string, JsonValue>,
      })
    }
  }
  return tasks
}

export async function readPersistedActivityState(
  vendorSessionId: string,
  options: ActivityStateOptions = {},
): Promise<PersistedActivityState> {
  const root = configHome(options)
  const teamState = await readTeams(root, vendorSessionId)
  const activeTeam = teamState.teams.at(-1)
  const scannedTaskLists = [activeTeam
    ? activeTeam.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
    : vendorSessionId]
  const transcriptPath = options.transcriptPath === undefined
    ? await findTranscript(vendorSessionId)
    : options.transcriptPath
  const [transcriptState, tasks] = await Promise.all([
    readTranscriptState(transcriptPath),
    readTasks(root, scannedTaskLists),
  ])
  return {
    toolResults: transcriptState.toolResults,
    agentNotifications: transcriptState.agentNotifications,
    tasks,
    teams: teamState.teams,
    scannedTaskLists,
    teamScanComplete: teamState.complete,
  }
}
