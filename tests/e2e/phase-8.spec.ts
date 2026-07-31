import { expect, test, type APIRequestContext } from '@playwright/test'
import type { ArtifactRecord, HarnessEvent, SessionRecord, SessionSnapshot, WorkspaceRecord } from '@deepharness/protocol'
import { closeOpenSessions } from './support.ts'

async function post<T>(request: Parameters<typeof closeOpenSessions>[0], path: string, data: Record<string, unknown>): Promise<T> {
  const response = await request.post(path, { data, headers: { 'idempotency-key': crypto.randomUUID() } })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  expect(response.ok(), body.error ?? `${path} returned ${response.status()}`).toBe(true)
  return body
}

function unresolvedPermission(value: SessionSnapshot, turnId: string): HarnessEvent | undefined {
  const events = value.events.filter(event => event.turnId === turnId)
  const resolved = new Set(events
    .filter(event => event.type === 'permission.resolved')
    .map(event => String(event.payload.permissionRequestId)))
  return events.find(event => event.type === 'permission.requested'
    && !resolved.has(String(event.payload.permissionRequestId)))
}

async function createArtifact(request: APIRequestContext, sessionId: string): Promise<ArtifactRecord> {
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${sessionId}`)
    if (!response.ok()) return false
    const snapshot = await response.json() as SessionSnapshot
    return snapshot.session?.status === 'idle' && snapshot.session.processState === 'running'
  }, { timeout: 30_000 }).toBe(true)
  const { turnId } = await post<{ turnId: string }>(
    request, `/api/sessions/${sessionId}/prompts`,
    { text: '[tool:artifact] Publish the phase-eight Markdown fixture.' },
  )
  const resolving = new Set<string>()
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${sessionId}`)
    if (!response.ok()) return false
    const snapshot = await response.json() as SessionSnapshot
    const permission = unresolvedPermission(snapshot, turnId)
    if (permission) {
      const permissionId = String(permission.payload.permissionRequestId)
      if (!resolving.has(permissionId)) {
        resolving.add(permissionId)
        const options = Array.isArray(permission.payload.options)
          ? permission.payload.options as Array<Record<string, unknown>> : []
        const allow = options.find(option => /allow/i.test(
          `${String(option.kind ?? '')} ${String(option.optionId ?? '')}`,
        ))
        expect(allow, `No allow option for ${String(permission.payload.toolName)}`).toBeDefined()
        const resolved = await request.post(
          `/api/sessions/${sessionId}/permissions/${permissionId}/resolve`,
          {
            data: { optionId: String(allow!.optionId) },
            headers: { 'idempotency-key': crypto.randomUUID() },
          },
        )
        expect(resolved.ok()).toBe(true)
      }
    }
    return snapshot.events.some(event => event.turnId === turnId && event.type === 'turn.completed')
  }, { timeout: 60_000 }).toBe(true)
  let artifact: ArtifactRecord | undefined
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${sessionId}/artifacts`)
    if (!response.ok()) return false
    const body = await response.json() as { artifacts: ArtifactRecord[] }
    artifact = body.artifacts.find(item => item.turnId === turnId && item.status === 'ready')
    return artifact !== undefined
  }, { timeout: 30_000 }).toBe(true)
  return artifact!
}

test('renders artifacts and optional platform states on desktop and mobile', async ({ page, request }) => {
  test.setTimeout(90_000)
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await closeOpenSessions(request)
  const workspace = (await post<{ workspace: WorkspaceRecord }>(request, '/api/workspaces', {
    name: `Phase 8 browser ${crypto.randomUUID().slice(0, 8)}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a', mode: 'shared',
  })).workspace
  const session = (await post<{ session: SessionRecord }>(request, '/api/sessions', {
    workspaceId: workspace.id, permissionMode: 'acceptEdits',
  })).session
  const artifact = await createArtifact(request, session.id)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?sessionId=${session.id}`)
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Artifacts', exact: true }).first().click()
  await expect(page.getByTestId('artifact-panel')).toBeVisible()
  await expect(page.getByTestId('artifact-panel').getByText('phase-eight.md', { exact: true })).toBeVisible()
  await expect(page.getByTestId('artifact-panel').getByText(/text\/markdown/)).toBeVisible()
  await expect(page.getByTitle('Preview artifact')).toHaveAttribute(
    'href', `/api/sessions/${session.id}/artifacts/${artifact.id}/preview`,
  )
  await expect(page.getByTitle('Download artifact')).toHaveAttribute(
    'href', `/api/sessions/${session.id}/artifacts/${artifact.id}/download`,
  )
  await expect(page.getByTestId('lsp-panel')).toBeVisible()
  await expect(page.getByTestId('web-panel')).toBeVisible()
  await expect(page.getByTestId('platform-status-panel')).toBeVisible()
  await expect(page.getByTestId('platform-status-panel').getByText('terminal_capture', { exact: true })).toBeVisible()
  await expect(page.getByTestId('platform-status-panel').getByText(/WEB_BROWSER_TOOL compiled=false/)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-8-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.locator('.mobile-view-tabs').getByRole('button', { name: 'Artifacts', exact: true }).click()
  await expect(page.getByTestId('artifact-panel')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'output/playwright/phase-8-mobile.png', fullPage: true })
  expect(pageErrors).toEqual([])
  await post(request, `/api/sessions/${session.id}/close`, {})
})
