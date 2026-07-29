import { expect, test, type APIRequestContext } from '@playwright/test'
import type { SessionRecord, WorkspaceRecord } from '@deepharness/protocol'
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

test('invokes slash commands and inspects extension state on desktop and mobile', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await closeOpenSessions(request)
  const workspace = (await post<{ workspace: WorkspaceRecord }>(request, '/api/workspaces', {
    name: `Phase 5 browser ${crypto.randomUUID().slice(0, 8)}`,
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
  const palette = page.getByRole('button', { name: 'Slash commands' })
  await expect(palette).toBeEnabled({ timeout: 30_000 })
  await palette.click()
  await page.getByRole('textbox', { name: 'Search slash commands' }).fill('phase-five')
  await page.locator('.command-options button').filter({ hasText: '/phase-five' }).first().click()
  await page.locator('#command-args').fill('BROWSER_ARG')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('.message-row-user').last()).toContainText('/phase-five BROWSER_ARG')
  await expect(page.locator('.message-row-assistant').last()).toContainText('PHASE_FIVE_COMMAND_OK', {
    timeout: 60_000,
  })

  await page.getByRole('button', { name: 'Extensions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Extensions' })).toBeVisible()
  await expect(page.getByTestId('command-catalog')).toContainText('/phase-five')
  await expect(page.getByTestId('command-catalog')).toContainText('ACP blocked')
  await page.getByRole('tab', { name: 'skills' }).click()
  await expect(page.locator('.extension-rows')).toContainText('phase-five-skill')
  await expect(page.locator('.extension-rows')).toContainText('SearchExtraToolsTool')
  await page.getByRole('tab', { name: 'plugins' }).click()
  await expect(page.getByTestId('plugin-registry')).toContainText('phase-five@local')
  await page.getByRole('tab', { name: 'hooks' }).click()
  await expect(page.locator('.extension-rows')).toContainText('PreToolUse')
  await page.getByRole('tab', { name: 'mcp' }).click()
  await expect(page.getByTestId('mcp-registry')).toContainText('phase-five-test')
  await expect(page.getByTestId('mcp-registry')).toContainText('mcpClients=[]')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-5-desktop.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.mobile-view-tabs').getByRole('button', { name: 'Extensions' }).click()
  await page.getByRole('tab', { name: 'commands' }).click()
  await expect(page.getByTestId('command-catalog')).toContainText('/phase-five')
  const boxes = await page.locator([
    '.mobile-view-tabs:visible',
    '.extension-page:visible',
    '.extension-toolbar:visible',
    '.extension-row:visible',
  ].join(', ')).evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, width: box.width }
  }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(390)
    expect(box.width).toBeGreaterThan(0)
  }
  await page.screenshot({ path: 'output/playwright/phase-5-mobile.png', fullPage: true })
  expect(pageErrors).toEqual([])
  await post(request, `/api/sessions/${session.id}/close`, {})
})
