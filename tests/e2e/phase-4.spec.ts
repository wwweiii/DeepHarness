import { expect, test, type APIRequestContext } from '@playwright/test'
import type {
  SessionActivitySnapshot,
  SessionRecord,
  WorkspaceRecord,
} from '@deepharness/protocol'
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

async function sessionActivity(
  request: APIRequestContext,
  sessionId: string,
): Promise<SessionActivitySnapshot> {
  const response = await request.get(`/api/sessions/${sessionId}/activity`)
  expect(response.ok()).toBe(true)
  return response.json() as Promise<SessionActivitySnapshot>
}

test('observes and stops Agent activity across desktop and mobile Inspector views', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await closeOpenSessions(request)
  const suffix = crypto.randomUUID().slice(0, 8)
  const workspace = (await post<{ workspace: WorkspaceRecord }>(request, '/api/workspaces', {
    name: `Phase 4 browser ${suffix}`,
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
  const send = async (text: string) => {
    await page.getByRole('textbox', { name: 'Message' }).fill(text)
    await page.getByRole('button', { name: 'Send message' }).click()
  }
  const approvePending = async () => {
    const allow = page.locator('.approval-allow:visible').last()
    await expect(allow).toBeVisible({ timeout: 30_000 })
    await allow.click()
  }
  await send('[tool:agent-nested] Browser nested Agent projection')
  await approvePending()
  await expect.poll(async () => {
    const state = await sessionActivity(request, session.id)
    return state.agents.some(agent => agent.parentAgentId !== null && agent.status === 'completed')
  }, { timeout: 90_000 }).toBe(true)
  await page.getByRole('tab', { name: 'agents' }).click()
  await expect(page.getByTestId('agent-definitions').locator('.agent-definition-row').first()).toBeVisible()
  await expect(page.getByTestId('agent-activity-panel').locator('.agent-row')).toHaveCount(2, {
    timeout: 30_000,
  })
  const agentRows = await page.getByTestId('agent-activity-panel').locator('.agent-row')
    .evaluateAll(rows => rows.map(row => ({
      id: row.getAttribute('data-agent-id'),
      paddingLeft: getComputedStyle(row).paddingLeft,
      width: row.getBoundingClientRect().width,
    })))
  expect(new Set(agentRows.map(row => row.paddingLeft)).size).toBeGreaterThan(1)
  expect(agentRows.every(row => row.id && row.width > 0)).toBe(true)

  await send('[tool:task-create] task-subject:browser-task')
  await expect.poll(async () => (await sessionActivity(request, session.id)).tasks.length, {
    timeout: 60_000,
  }).toBeGreaterThan(0)
  await page.getByRole('tab', { name: 'tasks' }).click()
  await expect(page.getByTestId('task-activity-panel')).toContainText('browser-task')

  const teamName = `browser-team-${suffix}`
  await send(`[tool:team-create] team-name:${teamName}`)
  await approvePending()
  await expect.poll(async () => (await sessionActivity(request, session.id)).teams
    .some(team => team.name === teamName), { timeout: 60_000 }).toBe(true)
  await page.getByRole('tab', { name: 'teams' }).click()
  await expect(page.getByTestId('team-activity-panel')).toContainText(teamName)
  await expect(page.getByTestId('team-activity-panel')).toContainText('team-lead')

  await send('[tool:agent-async] Browser stoppable Agent')
  let backgroundId = ''
  await expect.poll(async () => {
    const background = (await sessionActivity(request, session.id)).agents.find(agent =>
      agent.description === 'Long running background agent'
        && agent.status === 'running'
        && Boolean(agent.vendorAgentId))
    backgroundId = background?.id ?? ''
    return Boolean(background)
  }, { timeout: 90_000 }).toBe(true)
  await page.getByRole('tab', { name: 'agents' }).click()
  const backgroundRow = page.locator(`[data-agent-id="${backgroundId}"]`)
  await expect(backgroundRow).toBeVisible()
  await backgroundRow.getByRole('button', { name: /Stop/ }).click()
  await expect.poll(async () => (await sessionActivity(request, session.id)).agents
    .find(agent => agent.id === backgroundId)?.status, { timeout: 60_000 }).toBe('stopped')
  await expect(backgroundRow).toContainText('stopped')

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-4-desktop.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.mobile-view-tabs').getByRole('button', { name: 'Activity' }).click()
  await page.getByRole('tab', { name: 'agents' }).click()
  await expect(page.getByTestId('agent-activity-panel')).toContainText('Long running background agent')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const boxes = await page.locator([
    '.mobile-view-tabs:visible',
    '.mobile-activity:visible',
    '.inspector-tabs:visible',
    '.activity-row:visible',
  ].join(', '))
    .evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, width: box.width }
    }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(390)
    expect(box.width).toBeGreaterThan(0)
  }
  await page.screenshot({ path: 'output/playwright/phase-4-mobile.png', fullPage: true })
  expect(pageErrors).toEqual([])

  await post(request, `/api/sessions/${session.id}/close`, {})
})
