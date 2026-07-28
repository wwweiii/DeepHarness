import { expect, test } from 'bun:test'
import type {
  HarnessEvent,
  SessionActivitySnapshot,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const workerUrl = process.env.WORKER_TEST_URL
const workerToken = process.env.WORKER_SHARED_TOKEN
const stackTest = baseUrl && workerUrl && workerToken ? test : test.skip

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
}

async function snapshot(sessionId: string): Promise<SessionSnapshot> {
  return request<SessionSnapshot>(`/api/session?sessionId=${encodeURIComponent(sessionId)}`)
}

async function activity(sessionId: string): Promise<SessionActivitySnapshot> {
  return request<SessionActivitySnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}/activity`)
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function unresolvedPermission(value: SessionSnapshot, turnId: string): HarnessEvent | undefined {
  const events = value.events.filter(event => event.turnId === turnId)
  const resolved = new Set(events
    .filter(event => event.type === 'permission.resolved')
    .map(event => String(event.payload.permissionRequestId)))
  return events.find(event => event.type === 'permission.requested'
    && !resolved.has(String(event.payload.permissionRequestId)))
}

function allowOption(request: HarnessEvent): string {
  const options = Array.isArray(request.payload.options)
    ? request.payload.options as Array<Record<string, unknown>>
    : []
  const option = options.find(candidate => /allow/i.test(
    `${String(candidate.kind ?? '')} ${String(candidate.optionId ?? '')}`,
  ))
  if (!option) throw new Error(`No allow option in ${JSON.stringify(options)}`)
  return String(option.optionId)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function prompt(sessionId: string, text: string): Promise<{ turnId: string; value: SessionSnapshot }> {
  const { turnId } = await post<{ turnId: string }>(`/api/sessions/${sessionId}/prompts`, { text })
  const started = Date.now()
  while (Date.now() - started < 120_000) {
    const value = await snapshot(sessionId)
    const permission = unresolvedPermission(value, turnId)
    if (permission) {
      expect([
        'ExecuteExtraTool',
        'TaskCreate',
        'TaskGet',
        'TaskList',
        'TaskUpdate',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'ListPeers',
      ]).toContain(String(permission.payload.toolName ?? ''))
      await post(
        `/api/sessions/${sessionId}/permissions/${String(permission.payload.permissionRequestId)}/resolve`,
        { optionId: allowOption(permission) },
      )
    } else if (value.events.some(event => event.turnId === turnId && event.type === 'turn.completed')) {
      return { turnId, value }
    }
    await Bun.sleep(100)
  }
  throw new Error(`Prompt ${turnId} timed out after 120000ms`)
}

stackTest('phase 4 Agent, Task, Team, control, and reconnect projection', async () => {
  const catalog = await request<{ sessions: SessionRecord[] }>('/api/sessions')
  for (const open of catalog.sessions.filter(session => session.status !== 'closed')) {
    await post(`/api/sessions/${open.id}/close`)
  }
  for (const open of catalog.sessions.filter(session => session.status !== 'closed')) {
    await waitFor(() => snapshot(open.id), value => value.session?.status === 'closed')
  }

  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 4 ${suffix}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a',
    mode: 'shared',
    readOnly: false,
  })).workspace
  const session = (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId: workspace.id,
    permissionMode: 'acceptEdits',
  })).session
  await waitFor(
    () => snapshot(session.id),
    value => value.session?.status === 'idle' && value.session.processState === 'running',
  )

  await prompt(session.id, '[tool:agent] Run the synchronous phase four sub-agent.')
  let state = await waitFor(
    () => activity(session.id),
    value => value.agents.some(agent => agent.description === 'Synchronous phase four agent'
      && agent.status === 'completed'
      && Boolean(agent.vendorAgentId)),
  )
  const syncAgent = state.agents.find(agent => agent.description === 'Synchronous phase four agent')!
  expect(syncAgent.agentType).toBe('Explore')
  expect(syncAgent.output).not.toBeNull()

  await prompt(session.id, '[tool:agent-plan] Run the built-in Plan Agent.')
  await prompt(session.id, '[tool:agent-verification] Run the built-in verification Agent.')
  await prompt(session.id, '[tool:agent-custom] Run the project custom Agent definition.')
  state = await waitFor(
    () => activity(session.id),
    value => ['Plan', 'verification', 'phase-four-checker'].every(agentType =>
      value.agents.some(agent => agent.agentType === agentType
        && agent.status === 'completed'
        && Boolean(agent.vendorAgentId)
        && agent.output !== null)),
  )
  expect(state.definitions.map(definition => definition.id)).toEqual(expect.arrayContaining([
    'agent.Explore',
    'agent.Plan',
    'agent.verification',
    'agent.custom-agent-definitions',
  ]))
  expect(state.limits).toMatchObject({ activeAgents: 0 })
  expect(state.limits?.observedAgentTokens).toBeGreaterThan(0)

  const nested = await prompt(session.id, '[tool:agent-nested] Run two nested Agent levels.')
  state = await waitFor(
    () => activity(session.id),
    value => value.agents.some(agent => agent.parentAgentId !== null),
  )
  const child = state.agents.find(agent => agent.parentAgentId !== null)!
  expect(state.agents.some(agent => agent.id === child.parentAgentId)).toBe(true)
  const nestedToolEvents = nested.value.events.filter(event =>
    event.turnId === nested.turnId
      && event.type.startsWith('tool.call_')
      && typeof event.payload.parentAgentId === 'string')
  expect(nestedToolEvents.length).toBeGreaterThan(0)
  expect(nestedToolEvents.every(event => event.payload.parentAgentId !== null)).toBe(true)

  const taskCreate = await prompt(session.id, `[tool:task-create] task-subject:phase-four-${suffix}`)
  const taskCreateResult = taskCreate.value.events.find(event => event.turnId === taskCreate.turnId
    && event.type === 'tool.call_completed'
    && event.payload.toolName === 'TaskCreate')
  expect(taskCreateResult).toMatchObject({ payload: { status: 'completed' } })
  state = await waitFor(
    () => activity(session.id),
    value => value.tasks.some(task => task.subject === `phase-four-${suffix}`),
  )
  const task = state.tasks.find(candidate => candidate.subject === `phase-four-${suffix}`)!
  expect(task.status).toBe('pending')
  await prompt(session.id, `[tool:task-update] task-id:${task.vendorTaskId} task-status:in_progress task-owner:builder`)
  await prompt(session.id, `[tool:task-get] task-id:${task.vendorTaskId}`)
  await prompt(session.id, '[tool:task-list]')
  state = await waitFor(
    () => activity(session.id),
    value => value.tasks.some(candidate => candidate.vendorTaskId === task.vendorTaskId
      && candidate.status === 'in_progress'
      && candidate.owner === 'builder'),
  )
  expect(state.tasks.find(candidate => candidate.vendorTaskId === task.vendorTaskId)?.metadata)
    .toMatchObject({ phase: 4, source: 'vendor_state' })

  const teamName = `phase-four-${suffix}`
  await prompt(session.id, `[tool:team-create] team-name:${teamName}`)
  state = await waitFor(
    () => activity(session.id),
    value => value.teams.some(team => team.name === teamName && team.status === 'active'),
  )
  expect(state.teams.find(team => team.name === teamName)?.peers)
    .toEqual(expect.arrayContaining([expect.objectContaining({ role: 'lead', name: 'team-lead' })]))
  expect(state.teams.find(team => team.name === teamName)?.deletedAt).toBeNull()
  state = await waitFor(
    () => activity(session.id),
    value => value.tasks.some(candidate => candidate.vendorTaskId === task.vendorTaskId
      && candidate.status === 'deleted'),
  )

  await prompt(session.id, `[tool:task-create] task-subject:team-task-${suffix}`)
  state = await waitFor(
    () => activity(session.id),
    value => value.tasks.some(candidate => candidate.subject === `team-task-${suffix}`),
  )
  const teamTask = state.tasks.find(candidate => candidate.subject === `team-task-${suffix}`)!

  await prompt(session.id, `[tool:team-agent] team-name:${teamName} agent-name:builder`)
  state = await waitFor(
    () => activity(session.id),
    value => value.teams.some(team => team.name === teamName
      && team.peers.some(peer => peer.name === 'builder')),
  )
  const builder = state.teams.find(team => team.name === teamName)!.peers
    .find(peer => peer.name === 'builder')!
  expect(builder.address).toBe(`builder@${teamName}`)

  await prompt(session.id, '[tool:send-message] message-to:builder')
  const listPeers = await prompt(session.id, '[tool:list-peers]')
  const listPeersResult = listPeers.value.events.find(event => event.turnId === listPeers.turnId
    && event.type === 'tool.call_completed'
    && event.payload.toolName === 'ListPeers')
  expect(listPeersResult).toMatchObject({
    payload: {
      status: 'failed',
      reconciliationSource: 'vendor_transcript',
    },
  })
  expect(String(listPeersResult?.payload.rawOutput ?? '')).toContain('not found')
  state = await waitFor(
    () => activity(session.id),
    value => value.messages.some(message => message.recipient === 'builder'),
  )
  expect(state.messages.find(message => message.recipient === 'builder')).toMatchObject({
    sender: 'team-lead',
    deliveryStatus: 'delivered',
  })

  await prompt(session.id, '[tool:agent-async] Start a stoppable background Agent.')
  state = await waitFor(
    () => activity(session.id),
    value => value.agents.some(agent => agent.description === 'Long running background agent'
      && agent.status === 'running'
      && Boolean(agent.vendorAgentId)),
  )
  const background = state.agents.find(agent => agent.description === 'Long running background agent')!
  const taskOutput = await prompt(
    session.id,
    `[tool:task-output] task-id:${background.vendorAgentId}`,
  )
  expect(taskOutput.value.events.some(event => event.turnId === taskOutput.turnId
    && event.type === 'tool.call_completed'
    && event.payload.toolName === 'TaskOutput'
    && event.payload.status === 'completed')).toBe(true)
  state = await waitFor(
    () => activity(session.id),
    value => value.tasks.some(candidate => candidate.vendorTaskId === background.vendorAgentId
      && candidate.taskType === 'local_agent'),
  )
  expect(state.tasks.find(candidate => candidate.vendorTaskId === background.vendorAgentId)?.output)
    .not.toBeNull()
  await post(`/api/sessions/${session.id}/agents/${encodeURIComponent(background.id)}/stop`)
  state = await waitFor(
    () => activity(session.id),
    value => value.agents.some(agent => agent.id === background.id && agent.status === 'stopped'),
  )
  expect(state.agents.find(agent => agent.id === background.id)?.status).toBe('stopped')

  const beforeReconnect = (await snapshot(session.id)).session!.lastEventSeq
  const reconnect = await fetch(`${workerUrl}/internal/test/reconnect-gateway`, {
    method: 'POST',
    headers: { 'x-worker-token': workerToken! },
  })
  expect(reconnect.ok).toBe(true)
  expect(await reconnect.json()).toMatchObject({ disconnected: true })
  const reconnected = await waitFor(
    () => snapshot(session.id),
    value => value.events.some(event => event.seq > beforeReconnect
      && event.type === 'session.process_changed'
      && event.payload.reason === 'worker_reconnected'),
  )
  expect(reconnected.session?.processState).toBe('running')
  state = await activity(session.id)
  expect(state.tasks.some(candidate => candidate.id === teamTask.id
    && candidate.status === 'pending')).toBe(true)
  expect(state.teams.some(team => team.name === teamName
    && team.peers.some(peer => peer.name === 'builder'))).toBe(true)

  const teamDelete = await prompt(session.id, '[tool:team-delete]')
  const teamDeleteResult = teamDelete.value.events.find(event =>
    event.turnId === teamDelete.turnId
      && event.type === 'tool.call_completed'
      && event.payload.toolName === 'TeamDelete')
  expect(teamDeleteResult).toMatchObject({
    payload: {
      status: 'completed',
      reconciliationSource: 'vendor_transcript',
      rawOutput: {
        result: {
          success: false,
          team_name: teamName,
        },
      },
    },
  })
  expect(String(record(record(teamDeleteResult?.payload.rawOutput).result).message ?? ''))
    .toMatch(/active teammate|active member/i)
  state = await waitFor(
    () => activity(session.id),
    value => Boolean(value.teams.find(team => team.name === teamName)?.peers
      .find(peer => peer.name === 'builder')?.metadata.shutdownApproval),
  )
  expect(state.teams.find(team => team.name === teamName)?.peers
    .find(peer => peer.name === 'builder')?.metadata.shutdownApproval).toMatchObject({
      backendType: 'in-process',
    })
  expect(state.teams.find(team => team.name === teamName)?.status).toBe('active')

  await post(`/api/sessions/${session.id}/close`)
  await waitFor(() => snapshot(session.id), value => value.session?.status === 'closed')
  state = await waitFor(
    () => activity(session.id),
    value => value.agents.every(agent => !['starting', 'running', 'stopping'].includes(agent.status)),
  )
  expect(state.limits?.activeAgents).toBe(0)
  expect(state.teams.find(team => team.name === teamName)?.peers)
    .not.toContainEqual(expect.objectContaining({ status: 'active' }))
})
