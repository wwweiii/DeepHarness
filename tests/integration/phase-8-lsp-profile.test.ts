import { expect, test } from 'bun:test'
import type {
  HarnessEvent,
  LspLocationRecord,
  PlatformIntegrationRecord,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'

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
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body),
  })
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 120_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await read()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function unresolvedPermission(snapshot: SessionSnapshot, turnId: string): HarnessEvent | undefined {
  const events = snapshot.events.filter(event => event.turnId === turnId)
  const resolved = new Set(events.filter(event => event.type === 'permission.resolved')
    .map(event => String(event.payload.permissionRequestId)))
  return events.find(event => event.type === 'permission.requested'
    && !resolved.has(String(event.payload.permissionRequestId)))
}

profileTest('phase 8 TypeScript LSP profile preserves the locked ACP bootstrap blocker', async () => {
  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 8 LSP ${crypto.randomUUID().slice(0, 8)}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a', mode: 'shared',
  })).workspace
  const session = (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId: workspace.id, permissionMode: 'acceptEdits',
  })).session
  const readSnapshot = () => json<SessionSnapshot>(`/api/sessions/${session.id}`)
  await waitFor(readSnapshot, value => value.session?.status === 'idle' && value.session.processState === 'running')
  const platform = await waitFor(
    () => json<{ integrations: PlatformIntegrationRecord[] }>(`/api/sessions/${session.id}/platform`),
    value => value.integrations.some(item => item.kind === 'lsp'),
  )
  expect(platform.integrations.find(item => item.kind === 'lsp')).toMatchObject({
    status: 'blocked', enabled: false, profile: 'typescript',
  })
  expect(platform.integrations.find(item => item.kind === 'lsp')?.conditions.join(' '))
    .toContain('does not parse --plugin-dir or initialize the LSP manager')

  const { turnId } = await post<{ turnId: string }>(`/api/sessions/${session.id}/prompts`, {
    text: '[tool:lsp] Resolve the definition for the phaseEightValue reference.',
  })
  const resolving = new Set<string>()
  const completed = await waitFor(async () => {
    const snapshot = await readSnapshot()
    const permission = unresolvedPermission(snapshot, turnId)
    if (permission) {
      const id = String(permission.payload.permissionRequestId)
      if (!resolving.has(id)) {
        resolving.add(id)
        const options = Array.isArray(permission.payload.options)
          ? permission.payload.options as Array<Record<string, unknown>> : []
        const allow = options.find(option => /allow/i.test(`${String(option.kind)} ${String(option.optionId)}`))
        if (!allow) throw new Error(`No allow option for ${String(permission.payload.toolName)}`)
        await post(`/api/sessions/${session.id}/permissions/${id}/resolve`, { optionId: String(allow.optionId) })
      }
    }
    return snapshot
  }, value => value.events.some(event => event.turnId === turnId && event.type === 'turn.completed'))
  expect(completed.events.some(event => event.turnId === turnId && event.type === 'lsp.location')).toBe(false)
  const locations = await json<{ locations: LspLocationRecord[] }>(`/api/sessions/${session.id}/lsp/locations`)
  expect(locations.locations).toEqual([])
  await post(`/api/sessions/${session.id}/close`)
})
