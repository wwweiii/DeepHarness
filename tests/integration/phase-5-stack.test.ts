import { expect, test } from 'bun:test'
import type {
  HarnessEvent,
  SessionExtensionSnapshot,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const stackTest = baseUrl ? test : test.skip

async function response(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await response(path, init)
  const body = await result.json().catch(() => ({})) as T & { error?: string }
  if (!result.ok) throw new Error(body.error ?? `HTTP ${result.status}`)
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
  return request(`/api/session?sessionId=${encodeURIComponent(sessionId)}`)
}

async function extensions(sessionId: string): Promise<SessionExtensionSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/extensions`)
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

async function waitForTurn(sessionId: string, turnId: string): Promise<SessionSnapshot> {
  return waitFor(async () => {
    const value = await snapshot(sessionId)
    const permission = unresolvedPermission(value, turnId)
    if (permission) {
      const options = Array.isArray(permission.payload.options)
        ? permission.payload.options as Array<Record<string, unknown>>
        : []
      const allow = options.find(option => /allow/i.test(
        `${String(option.kind ?? '')} ${String(option.optionId ?? '')}`,
      ))
      if (!allow) throw new Error(`No allow option for ${String(permission.payload.toolName)}`)
      await post(
        `/api/sessions/${sessionId}/permissions/${String(permission.payload.permissionRequestId)}/resolve`,
        { optionId: String(allow.optionId) },
      )
    }
    return value
  }, value => value.events.some(event => event.turnId === turnId && event.type === 'turn.completed'))
}

async function prompt(sessionId: string, text: string): Promise<SessionSnapshot> {
  const result = await post<{ turnId: string }>(`/api/sessions/${sessionId}/prompts`, { text })
  return waitForTurn(sessionId, result.turnId)
}

stackTest('phase 5 commands, extensions, and explicit MCP boundaries', async () => {
  const catalog = await request<{ sessions: SessionRecord[] }>('/api/sessions')
  for (const open of catalog.sessions.filter(session => session.status !== 'closed')) {
    await post(`/api/sessions/${open.id}/close`)
  }
  for (const open of catalog.sessions.filter(session => session.status !== 'closed')) {
    await waitFor(() => snapshot(open.id), value => value.session?.status === 'closed')
  }
  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 5 ${crypto.randomUUID().slice(0, 8)}`,
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

  let state = await waitFor(
    () => extensions(session.id),
    value => value.commands.some(command => command.name === 'phase-five' && command.callable)
      && value.commands.some(command => command.name === 'phase-five-skill' && command.callable),
  )
  expect(state.commands.find(command => command.name === 'phase-five')).toMatchObject({
    source: 'acp',
    commandType: 'prompt',
    callable: true,
    inputHint: 'verification-marker',
  })
  expect(state.commands).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'hooks', commandType: 'local-jsx', callable: false }),
    expect.objectContaining({ name: 'mcp', commandType: 'local-jsx', callable: false }),
    expect.objectContaining({ name: 'plugin', commandType: 'local-jsx', callable: false }),
  ]))

  const invoked = await post<{ turnId: string }>(
    `/api/sessions/${session.id}/commands/phase-five/invoke`,
    { args: 'INTEGRATION_ARG' },
  )
  let conversation = await waitForTurn(session.id, invoked.turnId)
  expect(conversation.events.find(event => event.turnId === invoked.turnId
    && event.type === 'user.message_created')?.payload.text).toBe('/phase-five INTEGRATION_ARG')
  expect(conversation.events.filter(event => event.turnId === invoked.turnId
    && event.type === 'assistant.text_delta').map(event => event.payload.text).join(''))
    .toContain('PHASE_FIVE_COMMAND_OK')

  const builtInCommand = await post<{ turnId: string }>(
    `/api/sessions/${session.id}/commands/statusline/invoke`,
    {},
  )
  conversation = await waitForTurn(session.id, builtInCommand.turnId)
  expect(conversation.events.find(event => event.turnId === builtInCommand.turnId
    && event.type === 'user.message_created')?.payload.text).toBe('/statusline')

  const skillInvocation = await post<{ turnId: string }>(
    `/api/sessions/${session.id}/commands/phase-five-skill/invoke`,
    {},
  )
  conversation = await waitForTurn(session.id, skillInvocation.turnId)
  expect(conversation.events.filter(event => event.turnId === skillInvocation.turnId
    && event.type === 'assistant.text_delta').map(event => event.payload.text).join(''))
    .toContain('PHASE_FIVE_SKILL_OK')

  conversation = await prompt(session.id, '[tool:skill] Execute the project Skill through SkillTool.')
  expect(conversation.events.some(event => event.type === 'tool.call_completed'
    && event.payload.toolName === 'Skill'
    && event.payload.status === 'completed')).toBe(true)

  state = await extensions(session.id)
  expect(state.extensions).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'skill', name: 'phase-five-skill', source: 'project', status: 'ready' }),
    expect.objectContaining({ kind: 'plugin', name: 'phase-five@local', enabled: false, status: 'disabled' }),
    expect.objectContaining({ kind: 'hook', name: 'PreToolUse', source: 'project', status: 'ready' }),
    expect.objectContaining({ kind: 'extra_tool', name: 'SearchExtraToolsTool', status: 'ready' }),
    expect.objectContaining({ kind: 'extra_tool', name: 'ExecuteExtraTool', status: 'ready' }),
  ]))
  expect(JSON.stringify(state.extensions)).not.toContain('"command":"true"')
  expect(state.mcpServers).toEqual([
    expect.objectContaining({
      name: 'phase-five-test',
      endpoint: 'http://test-model:8090/mcp',
      health: 'blocked',
      supportsTools: false,
      supportsResources: false,
    }),
  ])
  expect(JSON.stringify(state.mcpServers)).not.toContain('credential=not-projected')

  const resources = await request<{
    available: boolean
    resources: unknown[]
    blockedReason: string
  }>(`/api/sessions/${session.id}/mcp/phase-five-test/resources`)
  expect(resources).toMatchObject({ available: false, resources: [] })
  expect(resources.blockedReason).toContain('mcpClients=[]')
  const auth = await response(`/api/sessions/${session.id}/mcp/phase-five-test/auth`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  expect(auth.status).toBe(409)
  expect((await auth.json() as { error: string }).error).toContain('mcpClients=[]')
  const oauth = await response('/api/mcp/oauth/callback?code=must-not-be-stored')
  expect(oauth.status).toBe(501)
  expect(await oauth.json()).toMatchObject({ credentialsStored: false })

  const blocked = await response(`/api/sessions/${session.id}/commands/hooks/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: '{}',
  })
  expect(blocked.status).toBe(409)
  await post(`/api/sessions/${session.id}/close`)
})
