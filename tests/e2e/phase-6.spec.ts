import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SessionContextSnapshot, SessionRecord, WorkspaceRecord } from '@deepharness/protocol'
import { closeOpenSessions } from './support.ts'

async function post<T>(
  request: APIRequestContext,
  path: string,
  data: Record<string, unknown>,
): Promise<T> {
  const response = await request.post(path, {
    data,
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  expect(response.ok(), body.error ?? `${path} returned ${response.status()}`).toBe(true)
  return body
}

async function context(request: APIRequestContext, sessionId: string): Promise<SessionContextSnapshot> {
  const response = await request.get(`/api/sessions/${sessionId}/context`)
  expect(response.ok()).toBe(true)
  return response.json() as Promise<SessionContextSnapshot>
}

test('inspects Memory and Context state across desktop and mobile', async ({ page, request }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await closeOpenSessions(request)

  const suffix = crypto.randomUUID().slice(0, 8)
  const workerUrl = process.env.WORKER_TEST_URL
  const workerToken = process.env.WORKER_SHARED_TOKEN
  expect(workerUrl).toBeTruthy()
  expect(workerToken).toBeTruthy()
  const seed = await fetch(`${workerUrl}/internal/test/memory/local`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-worker-token': workerToken!,
    },
    body: JSON.stringify({
      store: 'phase-six',
      key: 'verification',
      content: `BROWSER_PRIVATE_MEMORY_${suffix}`,
    }),
  })
  expect(seed.ok).toBe(true)

  const workspace = (await post<{ workspace: WorkspaceRecord }>(request, '/api/workspaces', {
    name: `Phase 6 browser ${suffix}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a',
    mode: 'shared',
  })).workspace
  const session = (await post<{ session: SessionRecord }>(request, '/api/sessions', {
    workspaceId: workspace.id,
    permissionMode: 'acceptEdits',
  })).session

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?sessionId=${session.id}`)
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('textbox', { name: 'Message' }).fill(
    '[tool:local-memory] memory-store:phase-six memory-key:verification',
  )
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByText('LOCAL_MEMORY_RECALL_OK', { exact: true })).toBeVisible({ timeout: 60_000 })

  const desktopInspector = page.locator('.app-shell > .inspector')
  await desktopInspector.getByRole('tab', { name: 'context' }).click()
  const panel = desktopInspector.getByTestId('context-memory-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByTestId('context-usage')).toContainText('Window')
  await expect(panel.getByTestId('memory-observations')).toContainText('phase-six/verification')
  await expect(panel.getByTestId('memory-observations')).toContainText('content redacted')
  await expect(panel.getByTestId('context-capabilities')).toContainText('CONTEXT_COLLAPSE')
  await expect(panel.getByTestId('context-capabilities')).toContainText('disabled')
  await expect(panel.getByTestId('context-capabilities')).toContainText('rewind')
  await expect(panel.getByTestId('context-capabilities')).toContainText('blocked')

  const compact = panel.getByRole('button', { name: 'Compact context' })
  await expect(compact).toBeEnabled({ timeout: 30_000 })
  await compact.click()
  await expect.poll(async () => (await context(request, session.id)).checkpoints.length, {
    timeout: 90_000,
  }).toBeGreaterThan(0)
  await expect(panel.getByTestId('transcript-context')).toContainText('manual · completed', {
    timeout: 30_000,
  })
  await expect(panel.getByTestId('data-lifecycle-boundaries')).toContainText('Data lifecycle')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-6-desktop.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.mobile-view-tabs').getByRole('button', { name: 'Activity' }).click()
  const mobileInspector = page.locator('.mobile-activity .inspector')
  await mobileInspector.getByRole('tab', { name: 'context' }).click()
  await expect(mobileInspector.getByTestId('memory-observations')).toContainText('content redacted')
  await expect(mobileInspector.getByTestId('transcript-context')).toContainText('manual · completed')
  const boxes = await mobileInspector.locator([
    '.inspector-tabs',
    '.context-meter-row',
    '.context-metrics',
    '.memory-observation',
    '.context-capability-list',
  ].join(', ')).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, width: box.width }
  }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(390)
    expect(box.width).toBeGreaterThan(0)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-6-mobile.png', fullPage: true })
  expect(pageErrors).toEqual([])
  await post(request, `/api/sessions/${session.id}/close`, {})
})
