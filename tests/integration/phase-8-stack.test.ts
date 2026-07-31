import { expect, test } from 'bun:test'
import type {
  ArtifactRecord,
  HarnessEvent,
  PlatformIntegrationRecord,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const databaseUrl = process.env.DATABASE_URL
const stackTest = baseUrl && databaseUrl ? test : test.skip

async function request<T>(path: string, init?: RequestInit): Promise<{ response: Response; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  return { response, body }
}

async function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const result = await request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(body),
  })
  if (!result.response.ok) throw new Error(result.body.error ?? `HTTP ${result.response.status}`)
  return result.body
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

function unresolvedPermission(value: SessionSnapshot, turnId: string): HarnessEvent | undefined {
  const events = value.events.filter(event => event.turnId === turnId)
  const resolved = new Set(events
    .filter(event => event.type === 'permission.resolved')
    .map(event => String(event.payload.permissionRequestId)))
  return events.find(event => event.type === 'permission.requested'
    && !resolved.has(String(event.payload.permissionRequestId)))
}

async function prompt(sessionId: string, text: string): Promise<{ turnId: string; snapshot: SessionSnapshot }> {
  const { turnId } = await post<{ turnId: string }>(`/api/sessions/${sessionId}/prompts`, { text })
  const resolving = new Set<string>()
  const completed = await waitFor(async () => {
    const value = (await request<SessionSnapshot>(`/api/sessions/${sessionId}`)).body
    const permission = unresolvedPermission(value, turnId)
    if (permission) {
      const permissionId = String(permission.payload.permissionRequestId)
      if (!resolving.has(permissionId)) {
        resolving.add(permissionId)
        const options = Array.isArray(permission.payload.options)
          ? permission.payload.options as Array<Record<string, unknown>> : []
        const allow = options.find(option => /allow/i.test(
          `${String(option.kind ?? '')} ${String(option.optionId ?? '')}`,
        ))
        if (!allow) throw new Error(`No allow option for ${String(permission.payload.toolName)}`)
        await post(`/api/sessions/${sessionId}/permissions/${permissionId}/resolve`, {
          optionId: String(allow.optionId),
        })
      }
    }
    return value
  }, value => value.events.some(event => event.turnId === turnId && event.type === 'turn.completed'))
  return { turnId, snapshot: completed }
}

stackTest('phase 8 durable Artifact/LSP/Web/platform surfaces', async () => {
  const catalog = await request<{ sessions: SessionRecord[] }>('/api/sessions')
  for (const open of catalog.body.sessions.filter(item => item.status !== 'closed')) {
    await post(`/api/sessions/${open.id}/close`).catch(() => undefined)
  }
  for (const open of catalog.body.sessions.filter(item => item.status !== 'closed')) {
    await waitFor(
      () => request<SessionSnapshot>(`/api/sessions/${open.id}`),
      value => value.body.session?.status === 'closed',
    )
  }
  const workspace = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 8 ${crypto.randomUUID().slice(0, 8)}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-a', mode: 'shared', readOnly: false,
  })).workspace
  const session = (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId: workspace.id, permissionMode: 'acceptEdits',
  })).session
  const snapshot = () => request<SessionSnapshot>(`/api/sessions/${session.id}`)
  await waitFor(snapshot, value => value.body.session?.status === 'idle' && value.body.session.processState === 'running')

  const artifactTurn = await prompt(session.id, '[tool:artifact] Publish the phase-eight Markdown fixture.')
  const artifactTool = artifactTurn.snapshot.events.find(event =>
    event.turnId === artifactTurn.turnId
    && ['tool.call_started', 'tool.call_updated', 'tool.call_completed'].includes(event.type)
    && /artifact/i.test(String(event.payload.toolName ?? '')))
  expect(artifactTool).toBeDefined()

  const registry = await waitFor(
    () => request<{ artifacts: ArtifactRecord[] }>(`/api/sessions/${session.id}/artifacts`),
    value => value.body.artifacts.some(artifact => artifact.status === 'ready'),
  )
  const artifact = registry.body.artifacts.find(item => item.status === 'ready')!
  expect(artifact).toMatchObject({
    sessionId: session.id,
    turnId: artifactTurn.turnId,
    kind: 'file',
    name: 'phase-eight.md',
    workspaceRelativePath: 'phase-eight.md',
    relativePath: 'phase-eight.md',
    mimeType: 'text/markdown',
    status: 'ready',
    previewStatus: 'available',
    previewable: true,
    downloadable: true,
    contentAvailable: true,
    storagePath: null,
  })
  expect(artifact.toolCallId).toBeTruthy()
  expect(artifact.sizeBytes).toBeGreaterThan(0)
  expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(artifact.contentHash).toBe(artifact.sha256)

  const preview = await fetch(`${baseUrl}/api/sessions/${session.id}/artifacts/${artifact.id}/preview`)
  expect(preview.status).toBe(200)
  expect(preview.headers.get('content-type')).toContain('text/markdown')
  expect(preview.headers.get('x-content-type-options')).toBe('nosniff')
  expect(preview.headers.get('cache-control')).toBe('private, no-store')
  expect(preview.headers.get('content-disposition')).toContain('inline')
  expect(preview.headers.get('content-security-policy')).toContain("default-src 'none'")
  expect(await preview.text()).toBe('# DeepHarness Phase 8\n\nACP artifact preview and download verification.\n')

  const download = await fetch(`${baseUrl}/api/sessions/${session.id}/artifacts/${artifact.id}/download`)
  expect(download.status).toBe(200)
  expect(download.headers.get('content-disposition')).toContain('attachment')
  expect(await download.text()).toContain('ACP artifact preview and download verification.')

  const networkTurn = await prompt(
    session.id,
    '[tool:web-fetch-private] Attempt to fetch the Docker control-plane Gateway.',
  )
  const networkRequest = networkTurn.snapshot.events.find(event =>
    event.turnId === networkTurn.turnId
    && event.type === 'permission.requested'
    && event.payload.networkPolicyDecision === 'blocked')
  expect(networkRequest?.payload).toMatchObject({
    networkHost: 'gateway',
    networkPolicy: 'public-web',
    networkPolicyDecision: 'blocked',
    networkPolicyReason: 'OUTBOUND_NETWORK_PRIVATE_TARGET',
  })
  expect(networkTurn.snapshot.events.find(event => event.turnId === networkTurn.turnId
    && event.type === 'permission.resolved'
    && event.payload.permissionRequestId === networkRequest?.payload.permissionRequestId)?.payload.status)
    .toBe('denied')

  const workspaceB = (await post<{ workspace: WorkspaceRecord }>('/api/workspaces', {
    name: `Phase 8 isolation ${crypto.randomUUID().slice(0, 8)}`,
    containerPath: '/workspace/source/tests/fixtures/workspace-b', mode: 'shared', readOnly: false,
  })).workspace
  const sessionB = (await post<{ session: SessionRecord }>('/api/sessions', {
    workspaceId: workspaceB.id, permissionMode: 'acceptEdits',
  })).session
  await waitFor(
    () => request<SessionSnapshot>(`/api/sessions/${sessionB.id}`),
    value => value.body.session?.status === 'idle' && value.body.session.processState === 'running',
  )
  expect((await fetch(`${baseUrl}/api/sessions/${sessionB.id}/artifacts/${artifact.id}/preview`)).status).toBe(404)
  expect((await fetch(`${baseUrl}/api/artifacts/${artifact.id}/preview`)).status).toBe(404)

  const diagnostics = await request<{ diagnostics: unknown[] }>(`/api/sessions/${session.id}/lsp/diagnostics`)
  expect(diagnostics.response.ok).toBe(true)
  expect(diagnostics.body.diagnostics).toEqual([])
  const locations = await request<{ locations: unknown[] }>(`/api/sessions/${session.id}/lsp/locations`)
  expect(locations.response.ok).toBe(true)
  expect(locations.body.locations).toEqual([])
  const sources = await request<{ sources: unknown[] }>(`/api/sessions/${session.id}/web/sources`)
  expect(sources.response.ok).toBe(true)
  expect(sources.body.sources).toEqual([])

  const platform = await waitFor(
    () => request<{ integrations: PlatformIntegrationRecord[] }>(`/api/sessions/${session.id}/platform`),
    value => value.body.integrations.length >= 8,
  )
  for (const kind of ['lsp', 'browser', 'terminal_capture', 'powershell', 'ssh', 'bridge', 'voice']) {
    expect(platform.body.integrations.find(item => item.kind === kind)).toMatchObject({ status: 'blocked', enabled: false })
  }
  expect(platform.body.integrations.find(item => item.kind === 'browser')?.conditions.join(' '))
    .toContain('WEB_BROWSER_TOOL compiled=false')

  await post(`/api/sessions/${sessionB.id}/close`)
  await post(`/api/sessions/${session.id}/close`)
})
