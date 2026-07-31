import { expect, test } from 'bun:test'
import type { PlatformIntegrationRecord, SessionRecord, SessionSnapshot, WorkspaceRecord } from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const profileTest = baseUrl ? test : test.skip

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `${path} returned ${response.status}`)
  return body
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return json<T>(path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body),
  })
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 90_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

profileTest('phase 8 Chromium profile preserves the locked WebBrowser compile blocker', async () => {
  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 8 Browser ${crypto.randomUUID().slice(0, 8)}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a', mode: 'shared',
  })).workspace
  const session = (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId: workspace.id, permissionMode: 'acceptEdits',
  })).session
  await waitFor(
    () => json<SessionSnapshot>(`/api/sessions/${session.id}`),
    value => value.session?.status === 'idle' && value.session.processState === 'running',
  )
  const platform = await waitFor(
    () => json<{ integrations: PlatformIntegrationRecord[] }>(`/api/sessions/${session.id}/platform`),
    value => value.integrations.some(item => item.kind === 'browser'),
  )
  const browser = platform.integrations.find(item => item.kind === 'browser')!
  expect(browser).toMatchObject({ profile: 'chromium', status: 'blocked', enabled: false })
  expect(browser.conditions.join(' ')).toContain('WEB_BROWSER_TOOL compiled=false')
  expect(browser.conditions.join(' ')).not.toContain('Chromium executable is missing')
  await post(`/api/sessions/${session.id}/close`)
})
