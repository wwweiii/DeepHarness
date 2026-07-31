import { expect, test, type APIRequestContext } from '@playwright/test'
import type { BackgroundJobRecord, SessionRecord, WorkspaceRecord } from '@deepharness/protocol'
import { closeOpenSessions } from './support.ts'

async function post<T>(request: APIRequestContext, path: string, data: Record<string, unknown>): Promise<T> {
  const response = await request.post(path, { data, headers: { 'idempotency-key': crypto.randomUUID() } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  expect(response.ok(), body.error ?? `${path} returned ${response.status()}`).toBe(true)
  return body
}

test('opens the durable automation control plane on desktop and mobile', async ({ page, request }) => {
  test.setTimeout(120_000)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await closeOpenSessions(request)
  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = (await post<{ workspace: WorkspaceRecord }>(request, '/api/workspaces', {
    name: `Phase 7 browser ${suffix}`, containerPath: '/workspace/source/tests/fixtures/workspace-a', mode: 'shared',
  })).workspace
  const session = (await post<{ session: SessionRecord }>(request, '/api/sessions', {
    workspaceId: workspace.id, permissionMode: 'acceptEdits',
  })).session
  const background = (await post<{ job: BackgroundJobRecord }>(request, '/api/background-jobs', {
    sessionId: session.id, type: 'sleep', title: `Browser sleeper ${suffix}`, prompt: 'browser attach fixture', delayMs: 3_600_000,
  })).job

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?sessionId=${session.id}`)
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Automation', exact: true }).first().click()
  const panel = page.getByTestId('automation-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Goals and automation', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'background', exact: true }).click()
  await expect(panel.getByText(`Browser sleeper ${suffix}`, { exact: true })).toBeVisible()
  await panel.getByTitle('Attach to background output').click()
  await expect(panel.getByText('No output yet', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-7-desktop.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.mobile-view-tabs').getByRole('button', { name: 'Automation', exact: true }).click()
  await expect(page.getByTestId('automation-panel')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-7-mobile.png', fullPage: true })
  expect(pageErrors).toEqual([])
  await post(request, `/api/background-jobs/${background.id}/stop`, {})
  await post(request, `/api/sessions/${session.id}/close`, {})
})
