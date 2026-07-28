import { expect, test } from 'bun:test'
import postgres from 'postgres'
import type {
  EventPage,
  HarnessEvent,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'
import { GatewayStore } from '../../apps/gateway/src/store.ts'

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

async function postResponse(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
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

async function waitFor(
  sessionId: string,
  predicate: (value: SessionSnapshot) => boolean,
  timeoutMs = 90_000,
): Promise<SessionSnapshot> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await snapshot(sessionId)
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for session ${sessionId} after ${timeoutMs}ms`)
}

async function workerControl(action: string, sessionId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${workerUrl}/internal/test/${action}/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'x-worker-token': workerToken! },
  })
  if (!response.ok) throw new Error(`Worker control failed: ${response.status}`)
  return response.json() as Promise<Record<string, unknown>>
}

function event(value: SessionSnapshot, type: HarnessEvent['type'], afterSeq = 0): HarnessEvent | undefined {
  return value.events.find(candidate => candidate.seq > afterSeq && candidate.type === type)
}

function turnComplete(value: SessionSnapshot, turnId: string): boolean {
  return value.events.some(candidate => candidate.turnId === turnId && candidate.type === 'turn.completed')
}

async function prompt(sessionId: string, text: string): Promise<string> {
  return (await post<{ turnId: string }>(`/api/sessions/${sessionId}/prompts`, { text })).turnId
}

async function createWorkspace(
  name: string,
  containerPath: string,
  mode: 'shared' | 'worktree',
  readOnly = false,
): Promise<WorkspaceRecord> {
  return (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name,
    containerPath,
    mode,
    readOnly,
  })).workspace
}

async function createSession(workspaceId: string): Promise<SessionRecord> {
  return (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId,
    permissionMode: 'default',
  })).session
}

stackTest('phase 3 persistence, recovery, workspaces, concurrency, and cleanup', async () => {
  const catalog = await request<{ sessions: SessionRecord[] }>('/api/sessions')
  for (const session of catalog.sessions.filter(item => item.status !== 'closed')) {
    await post(`/api/sessions/${session.id}/close`)
  }
  for (const session of catalog.sessions.filter(item => item.status !== 'closed')) {
    await waitFor(session.id, value => value.session?.status === 'closed')
  }

  const suffix = crypto.randomUUID().slice(0, 8)
  const workspaceA = await createWorkspace(
    `Phase 3 Git shared ${suffix}`,
    '/workspace/source/tests/fixtures/workspace-a',
    'shared',
  )
  const workspaceB = await createWorkspace(
    `Phase 3 non-Git shared ${suffix}`,
    '/workspace/non-git',
    'shared',
  )
  const worktreeWorkspace = await createWorkspace(
    `Phase 3 worktree ${suffix}`,
    '/workspace/source',
    'worktree',
  )
  const workspaceAliasA = await createWorkspace(
    `Phase 3 Git shared alias ${suffix}`,
    '/workspace/source/tests/fixtures/workspace-a',
    'shared',
  )
  const readOnlyWorkspaceAliasA = await createWorkspace(
    `Phase 3 read-only alias ${suffix}`,
    '/workspace/source/tests/fixtures/workspace-a',
    'shared',
    true,
  )
  const invalidWorktreeWorkspace = await createWorkspace(
    `Phase 3 invalid worktree ${suffix}`,
    '/workspace/non-git',
    'worktree',
  )

  const [sessionA, sessionB] = await Promise.all([
    createSession(workspaceA.id),
    createSession(workspaceB.id),
  ])
  let [valueA, valueB] = await Promise.all([
    waitFor(sessionA.id, value => value.session?.status === 'idle' && value.session.processState === 'running'),
    waitFor(sessionB.id, value => value.session?.status === 'idle' && value.session.processState === 'running'),
  ])
  expect(valueA.session?.agentSessionId).toBeTruthy()
  expect(valueB.session?.agentSessionId).toBeTruthy()
  expect(valueA.session?.agentSessionId).not.toBe(valueB.session?.agentSessionId)
  const originalAgentA = valueA.session!.agentSessionId!

  const [seedA, seedB] = await Promise.all([
    prompt(sessionA.id, `phase 3 transcript seed A ${suffix}`),
    prompt(sessionB.id, `phase 3 transcript seed B ${suffix}`),
  ])
  await Promise.all([
    waitFor(sessionA.id, value => turnComplete(value, seedA)),
    waitFor(sessionB.id, value => turnComplete(value, seedB)),
  ])
  await Bun.sleep(250)

  const blocked = await postResponse('/api/sessions', {
    workspaceId: workspaceA.id,
    permissionMode: 'default',
  })
  expect(blocked.status).toBe(409)
  expect(await blocked.json()).toMatchObject({ error: expect.stringContaining('locked') })
  const aliasBlocked = await postResponse('/api/sessions', {
    workspaceId: workspaceAliasA.id,
    permissionMode: 'default',
  })
  expect(aliasBlocked.status).toBe(409)
  expect(await aliasBlocked.json()).toMatchObject({ error: expect.stringContaining('locked') })
  const readOnlyAliasBlocked = await postResponse('/api/sessions', {
    workspaceId: readOnlyWorkspaceAliasA.id,
    permissionMode: 'default',
  })
  expect(readOnlyAliasBlocked.status).toBe(409)
  expect(await readOnlyAliasBlocked.json()).toMatchObject({ error: expect.stringContaining('locked') })
  const lockedWorkspaceCatalog = await request<{ workspaces: WorkspaceRecord[] }>('/api/workspaces')
  expect(lockedWorkspaceCatalog.workspaces.find(item => item.id === workspaceAliasA.id))
    .toMatchObject({ lockedBySessionId: sessionA.id })

  const [slowA, slowB] = await Promise.all([
    prompt(sessionA.id, `[slow] phase 3 concurrent A ${suffix}`),
    prompt(sessionB.id, `[slow] phase 3 concurrent B ${suffix}`),
  ])
  ;[valueA, valueB] = await Promise.all([
    waitFor(sessionA.id, value => value.events.some(item => item.turnId === slowA && item.type === 'turn.started')),
    waitFor(sessionB.id, value => value.events.some(item => item.turnId === slowB && item.type === 'turn.started')),
  ])
  expect(turnComplete(valueA, slowA)).toBe(false)
  expect(turnComplete(valueB, slowB)).toBe(false)
  await Promise.all([
    post(`/api/sessions/${sessionA.id}/cancel`),
    post(`/api/sessions/${sessionB.id}/cancel`),
  ])
  await Promise.all([
    waitFor(sessionA.id, value => turnComplete(value, slowA)),
    waitFor(sessionB.id, value => turnComplete(value, slowB)),
  ])

  expect((await workerControl('crash', sessionA.id)).crashed).toBe(true)
  valueA = await waitFor(sessionA.id, value =>
    value.session?.processState === 'exited'
      && value.events.some(item => item.type === 'session.interrupted'),
  )
  valueB = await snapshot(sessionB.id)
  expect(valueB.session?.processState).toBe('running')
  const isolatedTurn = await prompt(sessionB.id, `phase 3 crash isolation ${suffix}`)
  await waitFor(sessionB.id, value => turnComplete(value, isolatedTurn))

  const resumeStartSeq = valueA.session!.lastEventSeq
  const resumedTurn = await prompt(sessionA.id, `phase 3 resume ${suffix}`)
  valueA = await waitFor(sessionA.id, value => turnComplete(value, resumedTurn))
  expect(valueA.session?.agentSessionId).toBe(originalAgentA)
  expect(valueA.events.some(item =>
    item.seq > resumeStartSeq
      && item.type === 'session.recovery_changed'
      && item.payload.strategy === 'resume',
  )).toBe(true)
  expect(valueA.session?.contextState).toMatchObject({
    recoveryStrategy: 'resume',
    capabilities: { compact: { state: 'vendor_managed', acpMethod: null } },
  })

  expect((await workerControl('stop', sessionA.id)).stopped).toBe(true)
  valueA = await waitFor(sessionA.id, value => value.session?.processState === 'stopped')
  const loadStartSeq = valueA.session!.lastEventSeq
  await post(`/api/sessions/${sessionA.id}/recover`, { strategy: 'load' })
  valueA = await waitFor(sessionA.id, value =>
    value.session?.status === 'idle'
      && value.session.processState === 'running'
      && value.events.some(item => item.seq > loadStartSeq
        && item.type === 'session.recovery_changed'
        && item.payload.strategy === 'load'),
  )
  expect(valueA.session?.agentSessionId).toBe(originalAgentA)

  const cancelledQueued = await createSession(worktreeWorkspace.id)
  await waitFor(cancelledQueued.id, value => value.session?.processState === 'queued')
  await post(`/api/sessions/${cancelledQueued.id}/close`)
  const cancelledQueuedValue = await waitFor(cancelledQueued.id, value =>
    value.session?.status === 'closed' && value.session.processState === 'stopped',
  )
  expect(cancelledQueuedValue.events.some(item => item.type === 'session.process_changed'
    && item.payload.reason === 'closed_while_queued')).toBe(true)

  const queued = await createSession(worktreeWorkspace.id)
  let queuedValue = await waitFor(queued.id, value => value.session?.processState === 'queued')
  expect(queuedValue.session?.agentSessionId).toBeNull()
  const workerHealth = await fetch(`${workerUrl}/health/ready`).then(response => response.json()) as {
    activeProcesses: number
    queuedProcesses: number
  }
  expect(workerHealth.activeProcesses).toBe(2)
  expect(workerHealth.queuedProcesses).toBe(1)
  expect((await workerControl('stop', sessionB.id)).stopped).toBe(true)
  await waitFor(sessionB.id, value => value.session?.processState === 'stopped')
  queuedValue = await waitFor(queued.id, value =>
    value.session?.status === 'idle' && value.session.processState === 'running',
  )
  expect(queuedValue.session?.worktreePath).toBe(`/workspace/runs/${queued.id}`)
  await post(`/api/sessions/${queued.id}/close`)
  queuedValue = await waitFor(queued.id, value => value.session?.status === 'closed'
    && value.events.some(item => item.type === 'workspace.lock_changed'
      && item.payload.worktreeRemoved === true))
  expect(queuedValue.events.some(item => item.type === 'workspace.lock_changed'
    && item.payload.worktreeRemoved === true)).toBe(true)

  const fork = (await post<{ session: SessionRecord }>(`/api/sessions/${sessionA.id}/fork`, {
    workspaceId: worktreeWorkspace.id,
  })).session
  let forkValue = await waitFor(fork.id, value =>
    value.session?.status === 'idle' && value.session.processState === 'running',
  )
  expect(forkValue.session?.parentSessionId).toBe(sessionA.id)
  expect(forkValue.session?.agentSessionId).toBeTruthy()
  expect(forkValue.session?.agentSessionId).not.toBe(originalAgentA)
  expect(forkValue.session?.worktreePath).toBe(`/workspace/runs/${fork.id}`)
  const forkTurn = await prompt(fork.id, `phase 3 fork ${suffix}`)
  await waitFor(fork.id, value => turnComplete(value, forkTurn))
  await post(`/api/sessions/${fork.id}/close`)
  forkValue = await waitFor(fork.id, value =>
    value.session?.status === 'closed'
      && value.events.some(item => item.type === 'workspace.lock_changed'
        && item.payload.worktreeRemoved === true),
  )
  expect(forkValue.events.some(item => item.payload.dirtyWorktreeRetained === true)).toBe(false)

  const invalidWorktreeSession = await createSession(invalidWorktreeWorkspace.id)
  const invalidWorktreeValue = await waitFor(invalidWorktreeSession.id, value =>
    value.session?.status === 'error' && value.session.processState === 'stopped',
  )
  expect(invalidWorktreeValue.events.some(item => item.type === 'session.process_changed'
    && item.payload.reason === 'workspace_prepare_failed')).toBe(true)

  expect((await workerControl('transcript/corrupt', sessionB.id)).damaged).toBe(true)
  await post(`/api/sessions/${sessionB.id}/recover`, { strategy: 'load' })
  valueB = await waitFor(sessionB.id, value => value.session?.status === 'recovery_required')
  expect(valueB.session?.recoveryError).toContain('TRANSCRIPT_CORRUPT')

  expect((await workerControl('stop', sessionA.id)).stopped).toBe(true)
  await waitFor(sessionA.id, value => value.session?.processState === 'stopped')
  expect((await workerControl('transcript/delete', sessionA.id)).damaged).toBe(true)
  await post(`/api/sessions/${sessionA.id}/recover`, { strategy: 'resume' })
  valueA = await waitFor(sessionA.id, value => value.session?.status === 'recovery_required')
  expect(valueA.session?.recoveryError).toContain('TRANSCRIPT_MISSING')

  const firstPage = await request<EventPage>(`/api/sessions/${sessionA.id}/history?limit=5`)
  expect(firstPage.events).toHaveLength(5)
  expect(firstPage.nextBeforeSeq).not.toBeNull()
  const secondPage = await request<EventPage>(
    `/api/sessions/${sessionA.id}/history?limit=5&beforeSeq=${firstPage.nextBeforeSeq}`,
  )
  expect(secondPage.events.length).toBeGreaterThan(0)
  expect(new Set([...firstPage.events, ...secondPage.events].map(item => item.id)).size)
    .toBe(firstPage.events.length + secondPage.events.length)
  expect(Math.max(...secondPage.events.map(item => item.seq)))
    .toBeLessThan(Math.min(...firstPage.events.map(item => item.seq)))

  const sql = postgres(databaseUrl!, { max: 8 })
  try {
    const gatewayStore = new GatewayStore(sql)
    const before = (await gatewayStore.getSession(sessionA.id))!.lastEventSeq
    const duplicateId = crypto.randomUUID()
    const duplicateInput = {
      id: duplicateId,
      sessionId: sessionA.id,
      turnId: null,
      type: 'context.updated' as const,
      payload: { test: 'duplicate-event' },
      source: 'gateway' as const,
    }
    const [left, right] = await Promise.all([
      gatewayStore.appendEvent(duplicateInput),
      gatewayStore.appendEvent(duplicateInput),
    ])
    expect(left.event.id).toBe(right.event.id)
    expect([left.inserted, right.inserted].filter(Boolean)).toHaveLength(1)

    const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      gatewayStore.appendEvent({
        id: crypto.randomUUID(),
        sessionId: sessionA.id,
        turnId: null,
        type: 'context.updated',
        payload: { concurrentIndex: index },
        source: 'gateway',
      })))
    const sequences = concurrent.map(item => item.event.seq).sort((a, b) => a - b)
    expect(sequences).toEqual(Array.from({ length: 12 }, (_, index) => before + 2 + index))

    const retryCandidates = await sql<{ id: string }[]>`
      SELECT id::text FROM session_commands
      WHERE session_id = ${sessionA.id} AND type = 'prompt'
      ORDER BY created_at ASC LIMIT 1
    `
    const retryId = retryCandidates[0]?.id
    expect(retryId).toBeTruthy()
    await sql`
      UPDATE session_commands SET status = 'delivered', acked_at = NULL,
        delivered_at = now() - interval '10 seconds', updated_at = now()
      WHERE id = ${retryId!}
    `
    const retried = await gatewayStore.retryTimedOutCommands(5_000)
    expect(retried.some(command => command.id === retryId)).toBe(true)
    await gatewayStore.markCommandDelivered(retryId!)
    await gatewayStore.markCommandResult(retryId!, true)
    const retriedRows = await sql<{ status: string; attempt_count: number }[]>`
      SELECT status, attempt_count FROM session_commands WHERE id = ${retryId!}
    `
    expect(retriedRows[0]).toMatchObject({ status: 'acked', attempt_count: 2 })

    const commandRows = await sql<{ status: string; attempt_count: number }[]>`
      SELECT status, attempt_count FROM session_commands
      WHERE session_id IN (
        ${sessionA.id}, ${sessionB.id}, ${cancelledQueued.id}, ${queued.id},
        ${fork.id}, ${invalidWorktreeSession.id}
      )
    `
    expect(commandRows.length).toBeGreaterThan(0)
    expect(commandRows.every(row => row.attempt_count >= 1)).toBe(true)
    expect(commandRows.every(row => ['acked', 'failed'].includes(row.status))).toBe(true)

    const locks = await sql<{ session_id: string }[]>`
      SELECT session_id::text FROM workspace_locks
      WHERE session_id IN (
        ${sessionA.id}, ${sessionB.id}, ${cancelledQueued.id}, ${queued.id},
        ${fork.id}, ${invalidWorktreeSession.id}
      )
    `
    expect(locks).toHaveLength(0)
  } finally {
    await sql.end()
  }

  await Promise.all([
    post(`/api/sessions/${sessionA.id}/close`),
    post(`/api/sessions/${sessionB.id}/close`),
    post(`/api/sessions/${invalidWorktreeSession.id}/close`),
  ])
  await Promise.all([
    waitFor(sessionA.id, value => value.session?.status === 'closed'),
    waitFor(sessionB.id, value => value.session?.status === 'closed'),
    waitFor(invalidWorktreeSession.id, value => value.session?.status === 'closed'),
  ])
}, 240_000)
