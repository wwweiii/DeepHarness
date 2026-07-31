import { expect, test } from 'bun:test'
import postgres from 'postgres'
import type {
  HarnessEvent,
  SessionContextSnapshot,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const workerUrl = process.env.WORKER_TEST_URL
const workerToken = process.env.WORKER_SHARED_TOKEN
const databaseUrl = process.env.DATABASE_URL
const stackTest = baseUrl && workerUrl && workerToken && databaseUrl ? test : test.skip

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
  return request(`/api/session?sessionId=${encodeURIComponent(sessionId)}`)
}

async function context(sessionId: string): Promise<SessionContextSnapshot> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/context`)
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

async function seedLocalMemory(input: {
  store: string
  key: string
  content: string
}): Promise<void> {
  const response = await fetch(`${workerUrl}/internal/test/memory/local`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-token': workerToken!,
    },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`Memory seed failed: ${response.status} ${await response.text()}`)
}

async function workerControl(action: string, sessionId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${workerUrl}/internal/test/${action}/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'x-worker-token': workerToken! },
  })
  if (!response.ok) throw new Error(`Worker control failed: ${response.status}`)
  return response.json() as Promise<Record<string, unknown>>
}

function memoryEvents(value: SessionSnapshot, toolCallId: string): HarnessEvent[] {
  return value.events.filter(event => String(event.payload.toolCallId ?? '') === toolCallId
    && [
      'tool.call_started',
      'tool.call_updated',
      'tool.call_completed',
      'permission.requested',
      'memory.observed',
    ].includes(event.type))
}

stackTest('phase 6 Memory, Context, compact, and advanced session lifecycle', async () => {
  const catalog = await request<{ sessions: SessionRecord[] }>('/api/sessions')
  for (const open of catalog.sessions.filter(session => session.status !== 'closed')) {
    await post(`/api/sessions/${open.id}/close`)
  }
  for (const open of catalog.sessions.filter(session => session.status !== 'closed')) {
    await waitFor(() => snapshot(open.id), value => value.session?.status === 'closed')
  }

  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 6 ${suffix}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a',
    mode: 'shared',
  })).workspace
  const worktreeWorkspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 6 fork ${suffix}`,
    containerPath: '/workspace/source',
    mode: 'worktree',
  })).workspace
  const localContent = `PHASE_SIX_PRIVATE_MEMORY_${suffix}`
  await seedLocalMemory({ store: 'phase-six', key: 'verification', content: localContent })

  const session = (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId: workspace.id,
    permissionMode: 'acceptEdits',
  })).session
  await waitFor(
    () => snapshot(session.id),
    value => value.session?.status === 'idle' && value.session.processState === 'running',
  )

  let contextState = await waitFor(
    () => context(session.id),
    value => value.operations.list !== undefined && value.capabilities.length > 0,
  )
  expect(contextState.operations).toMatchObject({
    list: expect.objectContaining({ state: 'supported', contentProjected: false }),
    load: true,
    resume: true,
    fork: true,
    compact: expect.objectContaining({ invocation: 'session/prompt:/compact' }),
    rewind: expect.objectContaining({ state: 'blocked' }),
  })
  expect(contextState.capabilities.find(item => item.id === 'feature.CONTEXT_COLLAPSE'))
    .toMatchObject({ compiled: false, state: 'disabled' })
  expect(contextState.capabilities.find(item => item.id === 'command.local.rewind'))
    .toMatchObject({ matrixClass: 'C', state: 'blocked' })

  let conversation = await prompt(
    session.id,
    '[tool:local-memory] memory-store:phase-six memory-key:verification',
  )
  const localObservation = conversation.events.find(event => event.type === 'memory.observed'
    && event.payload.sourceType === 'local_memory'
    && event.payload.hit === true)
  expect(localObservation).toBeDefined()
  expect(localObservation?.payload).toMatchObject({
    sourceLabel: 'phase-six/verification',
    operation: 'fetch',
    contentRedacted: true,
  })
  const localToolCallId = String(localObservation?.payload.toolCallId)
  expect(JSON.stringify(memoryEvents(conversation, localToolCallId))).not.toContain(localContent)

  conversation = await prompt(session.id, '[tool:vault-http] observe the missing Vault credential')
  const vaultObservation = conversation.events.find(event => event.type === 'memory.observed'
    && event.payload.sourceType === 'vault_http'
    && event.payload.errorCode !== null)
  expect(vaultObservation).toBeDefined()
  expect(vaultObservation?.payload).toMatchObject({
    sourceLabel: 'https://api.example.test/private/items',
    contentRedacted: true,
  })
  const vaultToolCallId = String(vaultObservation?.payload.toolCallId)
  const vaultProjection = JSON.stringify(memoryEvents(conversation, vaultToolCallId))
  for (const secret of [
    'phase-six-missing-key',
    'source=phase-six',
    '#verification',
    'Verify the redacted Vault failure projection.',
  ]) expect(vaultProjection).not.toContain(secret)

  contextState = await waitFor(
    () => context(session.id),
    value => value.memories.some(memory => memory.sourceType === 'local_memory' && memory.hit === true)
      && value.memories.some(memory => memory.sourceType === 'vault_http' && memory.errorCode !== null)
      && value.usage !== null
      && value.usage.usedTokens !== null
      && value.usage.sizeTokens !== null,
  )
  expect(contextState.usage?.percentage).toBeGreaterThanOrEqual(0)
  expect(contextState.memories.every(memory => memory.contentRedacted)).toBe(true)

  const compact = await post<{ turnId: string }>(`/api/sessions/${session.id}/context/compact`)
  conversation = await waitFor(
    () => snapshot(session.id),
    value => value.events.some(event => event.turnId === compact.turnId && event.type === 'turn.completed')
      && value.events.some(event => event.turnId === compact.turnId && event.type === 'context.compacted'),
  )
  expect(conversation.events.filter(event => event.turnId === compact.turnId
    && event.type === 'assistant.text_delta')).toHaveLength(0)
  contextState = await waitFor(
    () => context(session.id),
    value => value.checkpoints.length > 0 && (value.transcript?.compactCount ?? 0) > 0,
  )
  expect(contextState.checkpoints[0]).toMatchObject({
    kind: 'compact',
    trigger: 'manual',
    status: 'completed',
    source: 'vendor_transcript_metadata',
  })
  expect(contextState.checkpoints[0]?.boundaryId).toBeTruthy()
  expect(contextState.transcript?.latestCompactBoundaryId)
    .toBe(contextState.checkpoints[0]?.boundaryId)
  conversation = await prompt(session.id, 'phase 6 execution after compact')
  expect(conversation.events.filter(event => event.type === 'assistant.text_delta'
    && event.turnId !== compact.turnId).map(event => event.payload.text).join(''))
    .toContain('phase 6 execution after compact')

  const sql = postgres(databaseUrl!, { max: 4 })
  try {
    await sql`
      UPDATE sessions SET last_vendor_commit = 'phase-six-previous-vendor'
      WHERE id = ${session.id}
    `
  } finally {
    await sql.end()
  }
  expect((await workerControl('stop', session.id)).stopped).toBe(true)
  let sessionState = await waitFor(
    () => snapshot(session.id),
    value => value.session?.processState === 'stopped',
  )
  const resumeAfterSeq = sessionState.session!.lastEventSeq
  await post(`/api/sessions/${session.id}/recover`, { strategy: 'resume' })
  sessionState = await waitFor(
    () => snapshot(session.id),
    value => value.session?.status === 'idle'
      && value.session.processState === 'running'
      && value.events.some(event => event.seq > resumeAfterSeq
        && event.type === 'session.recovery_changed'
        && event.payload.strategy === 'resume'),
  )
  contextState = await context(session.id)
  expect(contextState.compatibility).toMatchObject({
    status: 'compatible',
    crossVersion: true,
    previousVendorCommit: 'phase-six-previous-vendor',
  })

  expect((await workerControl('stop', session.id)).stopped).toBe(true)
  sessionState = await waitFor(
    () => snapshot(session.id),
    value => value.session?.processState === 'stopped',
  )
  const loadAfterSeq = sessionState.session!.lastEventSeq
  await post(`/api/sessions/${session.id}/recover`, { strategy: 'load' })
  await waitFor(
    () => snapshot(session.id),
    value => value.session?.status === 'idle'
      && value.session.processState === 'running'
      && value.events.some(event => event.seq > loadAfterSeq
        && event.type === 'session.recovery_changed'
        && event.payload.strategy === 'load'),
  )

  const fork = (await post<{ session: SessionRecord }>(`/api/sessions/${session.id}/fork`, {
    workspaceId: worktreeWorkspace.id,
  })).session
  await waitFor(
    () => snapshot(fork.id),
    value => value.session?.status === 'idle' && value.session.processState === 'running',
  )
  const forkContext = await context(fork.id)
  expect(forkContext.operations).toMatchObject({ load: true, resume: true, fork: true })
  expect((await prompt(fork.id, 'phase 6 fork after compact')).events
    .some(event => event.type === 'turn.completed')).toBe(true)

  await Promise.all([
    post(`/api/sessions/${fork.id}/close`),
    post(`/api/sessions/${session.id}/close`),
  ])
  await Promise.all([
    waitFor(() => snapshot(fork.id), value => value.session?.status === 'closed'),
    waitFor(() => snapshot(session.id), value => value.session?.status === 'closed'),
  ])
}, 300_000)
