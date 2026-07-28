import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import type {
  CapabilityView,
  HarnessEvent,
  SessionSnapshot,
} from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const databaseUrl = process.env.DATABASE_URL
const stackTest = baseUrl ? test : test.skip

type EvidenceEntry = {
  id: string
  scenario?: string
  workflow: string
  invocable?: boolean | null
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function snapshot(): Promise<SessionSnapshot> {
  return json<SessionSnapshot>('/api/session')
}

async function waitFor(
  predicate: (value: SessionSnapshot) => boolean,
  timeoutMs = 90_000,
): Promise<SessionSnapshot> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await snapshot()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  return json<T>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

async function prompt(sessionId: string, text: string): Promise<string> {
  const result = await post<{ turnId: string }>(`/api/sessions/${sessionId}/prompts`, { text })
  return result.turnId
}

function turnEvents(value: SessionSnapshot, turnId: string): HarnessEvent[] {
  return value.events.filter(event => event.turnId === turnId)
}

function eventOf(
  value: SessionSnapshot,
  turnId: string,
  type: HarnessEvent['type'],
): HarnessEvent | undefined {
  return turnEvents(value, turnId).find(event => event.type === type)
}

function unresolvedPermission(value: SessionSnapshot, turnId: string): HarnessEvent | undefined {
  const events = turnEvents(value, turnId)
  const resolved = new Set(events
    .filter(event => event.type === 'permission.resolved')
    .map(event => String(event.payload.permissionRequestId)))
  return events.find(event =>
    event.type === 'permission.requested'
      && !resolved.has(String(event.payload.permissionRequestId)),
  )
}

function permissionOption(request: HarnessEvent, allow: boolean): string {
  const options = Array.isArray(request.payload.options)
    ? request.payload.options as Array<Record<string, unknown>>
    : []
  const pattern = allow ? /allow/i : /reject|deny/i
  const option = options.find(candidate =>
    pattern.test(`${String(candidate.kind ?? '')} ${String(candidate.optionId ?? '')}`),
  )
  if (!option) throw new Error(`No ${allow ? 'allow' : 'reject'} option in ${JSON.stringify(options)}`)
  return String(option.optionId)
}

async function finishToolScenario(
  sessionId: string,
  entry: EvidenceEntry,
): Promise<SessionSnapshot> {
  const turnId = await prompt(sessionId, `${entry.scenario} phase 2 matrix ${entry.id}`)
  let value = await waitFor(current =>
    Boolean(unresolvedPermission(current, turnId))
      || Boolean(eventOf(current, turnId, 'turn.completed')),
  )
  const permission = unresolvedPermission(value, turnId)
  if (permission) {
    const replay = await snapshot()
    expect(unresolvedPermission(replay, turnId)?.id).toBe(permission.id)
    await post(
      `/api/sessions/${sessionId}/permissions/${String(permission.payload.permissionRequestId)}/resolve`,
      { optionId: permissionOption(permission, true) },
    )
  }
  value = await waitFor(current => Boolean(eventOf(current, turnId, 'turn.completed')))
  const events = turnEvents(value, turnId)
  if (entry.id === 'tool.TodoWriteTool') {
    expect(events.some(event => event.type === 'plan.updated')).toBe(true)
    expect(events.some(event => event.type === 'todo.updated')).toBe(true)
  } else {
    expect(events.some(event => event.type === 'tool.call_started')).toBe(true)
    const completed = events.find(event => event.type === 'tool.call_completed')
    expect(completed).toBeDefined()
    if (completed?.payload.inferred === true) {
      expect(completed.payload.rawOutput).toBeNull()
      expect(completed.payload.knownGap).toContain('raw output is unavailable')
    }
  }
  expect(events.some(event => event.type === 'usage.updated')).toBe(true)
  if (permission) {
    expect(events.find(event => event.type === 'permission.resolved')?.payload.status).toBe('approved')
  }
  return value
}

stackTest('phase 2 core tools, durable interactions, providers, and capability evidence', async () => {
  const evidence = JSON.parse(
    await readFile('config/harness-capability-evidence.json', 'utf8'),
  ) as { capabilities: EvidenceEntry[] }
  const coreTools = evidence.capabilities.filter(entry => entry.scenario)
  expect(coreTools.length).toBeGreaterThanOrEqual(10)

  let value = await snapshot()
  if (!value.session) {
    await post('/api/sessions', { permissionMode: 'default' })
  }
  value = await waitFor(current => current.session?.status === 'idle')
  const sessionId = value.session!.id

  await post(`/api/sessions/${sessionId}/mode`, { modeId: 'default' })
  value = await waitFor(current => current.session?.permissionMode === 'default')
  expect(value.events.some(event =>
    event.type === 'session.configuration_changed'
      && event.payload.permissionMode === 'default',
  )).toBe(true)

  const alternateModel = value.session!.availableModels.find(model => model.modelId === 'haiku')
    ?? value.session!.availableModels.find(model => model.modelId)
  expect(alternateModel).toBeDefined()
  await post(`/api/sessions/${sessionId}/model`, { modelId: alternateModel!.modelId })
  value = await waitFor(current => current.session?.modelId === alternateModel!.modelId)
  expect(value.session?.modelId).toBe(alternateModel!.modelId)

  for (const entry of coreTools.filter(candidate => candidate.workflow !== 'question')) {
    value = await finishToolScenario(sessionId, entry)
    if (entry.id === 'tool.BashTool') {
      const bashEvents = value.events.filter(event => event.payload.toolName === 'Bash')
      expect(bashEvents.some(event => event.type === 'tool.call_updated')).toBe(true)
    }
    if (entry.id === 'tool.EnterPlanModeTool') {
      await waitFor(current => current.session?.status === 'idle')
      await post(`/api/sessions/${sessionId}/mode`, { modeId: 'default' })
      await waitFor(current => current.session?.permissionMode === 'default')
    }
  }

  const questionEntry = coreTools.find(entry => entry.workflow === 'question')!
  const questionTurn = await prompt(sessionId, `${questionEntry.scenario} phase 2 durable question`)
  value = await waitFor(current =>
    Boolean(unresolvedPermission(current, questionTurn))
      && Boolean(eventOf(current, questionTurn, 'question.requested')),
  )
  const questionRequest = unresolvedPermission(value, questionTurn)!
  const questionReplay = await snapshot()
  expect(unresolvedPermission(questionReplay, questionTurn)?.id).toBe(questionRequest.id)
  await post(
    `/api/sessions/${sessionId}/questions/${String(questionRequest.payload.permissionRequestId)}/answer`,
    { answers: { 'Which verification path should continue?': 'Contract tests' } },
  )
  value = await waitFor(current => Boolean(eventOf(current, questionTurn, 'turn.completed')))
  const questionResolved = eventOf(value, questionTurn, 'question.resolved')
  expect(questionResolved?.payload.answers).toEqual({
    'Which verification path should continue?': 'Contract tests',
  })
  expect(questionResolved?.payload.status).toBe('approved')
  expect(turnEvents(value, questionTurn)
    .filter(event => event.type === 'assistant.text_delta')
    .map(event => String(event.payload.text ?? ''))
    .join('')).toContain('Contract tests')

  const rejectedTurn = await prompt(sessionId, '[tool:bash] phase 2 reject permission')
  value = await waitFor(current => Boolean(unresolvedPermission(current, rejectedTurn)))
  const rejectedRequest = unresolvedPermission(value, rejectedTurn)!
  await post(
    `/api/sessions/${sessionId}/permissions/${String(rejectedRequest.payload.permissionRequestId)}/resolve`,
    { optionId: permissionOption(rejectedRequest, false) },
  )
  value = await waitFor(current => Boolean(eventOf(current, rejectedTurn, 'turn.completed')))
  expect(eventOf(value, rejectedTurn, 'permission.resolved')?.payload.status).toBe('denied')

  const expiredTurn = await prompt(sessionId, '[tool:bash] phase 2 expire permission')
  value = await waitFor(current => Boolean(unresolvedPermission(current, expiredTurn)))
  const expiredRequestId = String(unresolvedPermission(value, expiredTurn)?.payload.permissionRequestId)
  value = await waitFor(current => turnEvents(current, expiredTurn).some(event =>
    event.type === 'permission.resolved'
      && event.payload.permissionRequestId === expiredRequestId
      && event.payload.status === 'expired',
  ), 30_000)
  value = await waitFor(current => Boolean(eventOf(current, expiredTurn, 'turn.completed')))
  expect(eventOf(value, expiredTurn, 'permission.resolved')?.payload.optionId).toBe('reject')

  const queueStartSeq = value.session!.lastEventSeq
  const firstQueuedTurn = await prompt(sessionId, '[queue] phase 2 first queued prompt')
  const secondQueuedTurn = await prompt(sessionId, 'phase 2 second queued prompt')
  value = await waitFor(current => current.events.some(event =>
    event.seq > queueStartSeq
      && event.type === 'prompt.queue_updated'
      && Number(event.payload.depth) >= 1
      && Array.isArray(event.payload.turnIds)
      && event.payload.turnIds.includes(secondQueuedTurn),
  ))
  const queuedEvent = value.events.find(event =>
    event.seq > queueStartSeq
      && event.type === 'prompt.queue_updated'
      && Array.isArray(event.payload.turnIds)
      && event.payload.turnIds.includes(secondQueuedTurn),
  )
  expect(queuedEvent?.payload.depth).toBeGreaterThanOrEqual(1)
  value = await waitFor(current =>
    Boolean(eventOf(current, firstQueuedTurn, 'turn.completed'))
      && Boolean(eventOf(current, secondQueuedTurn, 'turn.completed')),
  )
  expect(eventOf(value, firstQueuedTurn, 'turn.completed')!.seq)
    .toBeLessThan(eventOf(value, secondQueuedTurn, 'turn.completed')!.seq)
  await waitFor(current => current.session?.promptQueueDepth === 0)

  const capabilityView = await json<CapabilityView>('/api/capabilities')
  expect(capabilityView.providers).toHaveLength(7)
  expect(capabilityView.knownGaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'gap.acp.ask-user-question-updated-input' }),
  ]))
  for (const entry of evidence.capabilities) {
    const capability = capabilityView.capabilities.find(item => item.id === entry.id)
    expect(capability).toBeDefined()
    expect(capability?.tested).toBe(true)
    expect(capability?.ui_supported).toBe(true)
    expect(capability?.invocable).toBe(entry.invocable === undefined ? true : entry.invocable)
    expect(capability?.source_evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tests/integration/phase-2-stack.test.ts' }),
    ]))
  }
  const activeProvider = capabilityView.providers.find(provider => provider.active)
  expect(activeProvider).toMatchObject({
    id: 'anthropic',
    credentialStatus: 'configured',
    automatedTest: 'fake_passed',
  })
  for (const provider of capabilityView.providers.filter(item => item.id !== 'anthropic')) {
    expect(provider.active).toBe(false)
    expect(provider.credentialStatus).toBe('missing')
    expect(provider.automatedTest).not.toBe('fake_passed')
  }

  if (databaseUrl) {
    const sql = postgres(databaseUrl, { max: 1 })
    try {
      const [permissions, usage, audits] = await Promise.all([
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM permission_requests WHERE session_id = ${sessionId}`,
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM usage_records WHERE session_id = ${sessionId}`,
        sql<{ count: string }[]>`SELECT count(*)::text AS count FROM audit_logs WHERE action = 'permission.resolve'`,
      ])
      expect(Number(permissions[0]?.count)).toBeGreaterThanOrEqual(3)
      expect(Number(usage[0]?.count)).toBeGreaterThan(0)
      expect(Number(audits[0]?.count)).toBeGreaterThanOrEqual(3)
    } finally {
      await sql.end()
    }
  }
}, 180_000)
