import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SessionRecord, SessionSnapshot, WorkspaceRecord } from '@deepharness/protocol'

const workerUrl = process.env.WORKER_TEST_URL
const workerToken = process.env.WORKER_SHARED_TOKEN

async function post<T>(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  const response = await request.post(path, {
    data,
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  expect(response.ok(), body.error ?? `${path} returned ${response.status()}`).toBe(true)
  return body
}

async function sessionSnapshot(
  request: APIRequestContext,
  sessionId: string,
): Promise<SessionSnapshot> {
  const response = await request.get(`/api/sessions/${sessionId}`)
  expect(response.ok()).toBe(true)
  return response.json() as Promise<SessionSnapshot>
}

async function waitForSession(
  request: APIRequestContext,
  sessionId: string,
  predicate: (session: SessionRecord) => boolean,
  timeoutMs = 30_000,
): Promise<SessionRecord> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const snapshot = await sessionSnapshot(request, sessionId)
    if (snapshot.session && predicate(snapshot.session)) return snapshot.session
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for session ${sessionId}`)
}

async function waitForPrompt(
  request: APIRequestContext,
  sessionId: string,
  text: string,
  timeoutMs = 30_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const snapshot = await sessionSnapshot(request, sessionId)
    const userEvent = snapshot.events.find(event =>
      event.type === 'user.message_created' && event.payload.text === text)
    if (userEvent?.turnId && snapshot.events.some(event =>
      event.turnId === userEvent.turnId && event.type === 'turn.completed')) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for prompt in session ${sessionId}`)
}

async function workspaceFor(
  request: APIRequestContext,
  name: string,
  containerPath: string,
  mode: 'shared' | 'worktree',
): Promise<WorkspaceRecord> {
  const catalog = await request.get('/api/workspaces').then(response => response.json()) as {
    workspaces: WorkspaceRecord[]
  }
  const existing = catalog.workspaces.find(workspace =>
    workspace.containerPath === containerPath && workspace.mode === mode)
  if (existing) return existing
  return (await post<{ workspace: WorkspaceRecord }>(request, '/api/workspaces', {
    name,
    containerPath,
    mode,
  })).workspace
}

async function workerControl(action: string, sessionId: string): Promise<Record<string, unknown>> {
  if (!workerUrl || !workerToken) throw new Error('Worker test control is not configured')
  const response = await fetch(`${workerUrl}/internal/test/${action}/${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'x-worker-token': workerToken },
  })
  expect(response.ok).toBe(true)
  return response.json() as Promise<Record<string, unknown>>
}

test('switches durable sessions and exposes process recovery across browser restarts', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const initialCatalog = await request.get('/api/sessions').then(response => response.json()) as {
    sessions: SessionRecord[]
  }
  await Promise.all(initialCatalog.sessions
    .filter(session => session.status !== 'closed')
    .map(session => post(request, `/api/sessions/${session.id}/close`)))
  await Promise.all(initialCatalog.sessions
    .filter(session => session.status !== 'closed')
    .map(session => waitForSession(request, session.id, current => current.status === 'closed')))

  const [workspaceA, workspaceB, worktree] = await Promise.all([
    workspaceFor(
      request,
      'Browser workspace A',
      '/workspace/source/tests/fixtures/workspace-a',
      'shared',
    ),
    workspaceFor(request, 'Browser workspace B', '/workspace/non-git', 'shared'),
    workspaceFor(request, 'Browser worktrees', '/workspace/source', 'worktree'),
  ])

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByLabel('Workspace').selectOption(workspaceA.id)
  await page.getByRole('button', { name: 'Create session' }).click()
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => new URL(page.url()).searchParams.get('sessionId')).not.toBeNull()
  const sessionA = new URL(page.url()).searchParams.get('sessionId')!
  const composer = page.getByRole('textbox', { name: 'Message' })

  const promptA = `Browser durable session A ${crypto.randomUUID()}`
  await composer.fill(promptA)
  await page.getByRole('button', { name: 'Send message' }).click()
  await waitForPrompt(request, sessionA, promptA)
  await page.reload()
  await expect(page.getByText(`DeepHarness test model received: ${promptA}`, { exact: true }))
    .toBeVisible()

  await page.getByLabel('New session workspace').selectOption(workspaceB.id)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('.workbench-header p')).toHaveText(workspaceB.name, { timeout: 30_000 })
  const sessionB = new URL(page.url()).searchParams.get('sessionId')!
  expect(sessionB).not.toBe(sessionA)
  const promptB = `Browser durable session B ${crypto.randomUUID()}`
  await composer.fill(promptB)
  await page.getByRole('button', { name: 'Send message' }).click()
  await waitForPrompt(request, sessionB, promptB)
  await page.reload()
  await expect(page.getByText(`DeepHarness test model received: ${promptB}`, { exact: true }))
    .toBeVisible()

  await page.locator(`[data-session-id="${sessionA}"]`).click()
  await expect(page.getByText(promptA, { exact: true })).toBeVisible()
  await expect(page.getByText(promptB, { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText(promptA, { exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('sessionId')).toBe(sessionA)

  await post(request, `/api/sessions/${sessionB}/close`)
  await waitForSession(request, sessionB, session => session.status === 'closed')
  await page.getByLabel('New session workspace').selectOption(worktree.id)
  await page.getByRole('button', { name: 'Fork session' }).click()
  const recoveryRow = page.locator('.inspector dl > div').filter({ hasText: 'Recovery' })
  await expect(recoveryRow.getByRole('definition')).toHaveText('fork', { timeout: 30_000 })
  const forkSession = new URL(page.url()).searchParams.get('sessionId')!
  expect(forkSession).not.toBe(sessionA)
  const forkRecord = await waitForSession(request, forkSession, session =>
    session.status === 'idle'
      && session.processState === 'running'
      && session.worktreePath === `/workspace/runs/${forkSession}`)
  expect(forkRecord.parentSessionId).toBe(sessionA)

  const forkPrompt = `Browser fork context ${crypto.randomUUID()}`
  await composer.fill(forkPrompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await waitForPrompt(request, forkSession, forkPrompt)
  await page.reload()
  await expect(page.getByText(`DeepHarness test model received: ${forkPrompt}`, { exact: true }))
    .toBeVisible()
  await page.getByRole('button', { name: 'Close session' }).click()
  await waitForSession(request, forkSession, session => session.status === 'closed')

  await page.locator(`[data-session-id="${sessionA}"]`).click()
  expect((await workerControl('stop', sessionA)).stopped).toBe(true)
  const processRow = page.locator('.inspector dl > div').filter({ hasText: 'Process' })
  await expect(processRow.getByRole('definition')).toHaveText('stopped', { timeout: 30_000 })

  const resumedPrompt = `Browser automatic resume ${crypto.randomUUID()}`
  await composer.fill(resumedPrompt)
  await page.getByRole('button', { name: 'Send message' }).click()
  await waitForPrompt(request, sessionA, resumedPrompt)
  await page.reload()
  await expect(page.getByText(`DeepHarness test model received: ${resumedPrompt}`, { exact: true }))
    .toBeVisible()
  await expect(recoveryRow.getByRole('definition')).toHaveText('resume')

  expect((await workerControl('stop', sessionA)).stopped).toBe(true)
  await expect(processRow.getByRole('definition')).toHaveText('stopped', { timeout: 30_000 })
  expect((await workerControl('transcript/corrupt', sessionA)).damaged).toBe(true)
  await post(request, `/api/sessions/${sessionA}/recover`, { strategy: 'load' })
  const recoveryBanner = page.locator('.recovery-banner')
  await expect(recoveryBanner).toContainText('TRANSCRIPT_CORRUPT', { timeout: 30_000 })
  await expect(processRow.getByRole('definition')).toHaveText('stopped')

  const restartedPage = await page.context().newPage()
  await restartedPage.goto('/')
  await expect(restartedPage.getByText(promptA, { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(restartedPage.locator('.recovery-banner')).toContainText('TRANSCRIPT_CORRUPT')
  expect(new URL(restartedPage.url()).searchParams.get('sessionId')).toBe(sessionA)
  await page.close()

  await restartedPage.screenshot({ path: 'output/playwright/phase-3-desktop.png', fullPage: true })
  await restartedPage.setViewportSize({ width: 390, height: 844 })
  await restartedPage.reload()
  await expect(restartedPage.locator('.recovery-banner')).toContainText('TRANSCRIPT_CORRUPT')
  expect(await restartedPage.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true)
  const visibleBoxes = await restartedPage.locator(
    '.mobile-view-tabs, .workbench-header, .recovery-banner, .thread-viewport',
  ).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, width: box.width }
  }))
  for (const box of visibleBoxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(390)
    expect(box.width).toBeGreaterThan(0)
  }
  await restartedPage.screenshot({ path: 'output/playwright/phase-3-mobile.png', fullPage: true })

  await post(request, `/api/sessions/${sessionA}/close`)
  await waitForSession(request, sessionA, session => session.status === 'closed')
})
