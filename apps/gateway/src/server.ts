import { createDatabase, migrate } from '@deepharness/database'
import {
  WORKSPACE_ID,
  type CapabilityView,
  type GatewayToWorkerMessage,
  type HarnessEvent,
  type JsonValue,
  type ProviderProfile,
  type SessionSnapshot,
  type WorkerCommand,
  type WorkerToGatewayMessage,
} from '@deepharness/protocol'
import { Hono } from 'hono'
import { GatewayStore } from './store.ts'

const port = Number.parseInt(process.env.PORT ?? '8080', 10)
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
const workerToken = process.env.WORKER_SHARED_TOKEN ?? 'phase-1-local-token'
const workspacePath = process.env.WORKSPACE_PATH ?? '/workspace/source'
const webRoot = process.env.WEB_ROOT ?? '/app/apps/web/dist'
const manifestPath = process.env.CAPABILITY_MANIFEST_PATH
  ?? '/app/artifacts/capabilities/vendor-capability-manifest.json'
const providerProfilesPath = process.env.PROVIDER_PROFILES_PATH
  ?? '/app/config/provider-profiles.json'

const database = createDatabase(databaseUrl)
await migrate(database)
const store = new GatewayStore(database)

async function persistManifest(): Promise<void> {
  const file = Bun.file(manifestPath)
  if (!await file.exists()) throw new Error(`Capability manifest missing: ${manifestPath}`)
  const manifest = await file.json() as Record<string, unknown>
  const probeEnvironment = JSON.parse(JSON.stringify(manifest.probe_environment))
  const rawManifest = JSON.parse(JSON.stringify(manifest))
  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities as Array<Record<string, unknown>>
    : []
  await database.begin(async transaction => {
    const rows = await transaction<{ id: string }[]>`
      INSERT INTO capability_manifests (
        id, vendor_commit, build_id, schema_version, probe_environment,
        raw_manifest, status, generated_at
      ) VALUES (
        ${crypto.randomUUID()}, ${String(manifest.vendor_commit)},
        ${String(manifest.build_id)}, ${Number(manifest.schema_version)},
        ${transaction.json(probeEnvironment)},
        ${transaction.json(rawManifest)}, 'ready', ${new Date(String(manifest.generated_at))}
      )
      ON CONFLICT (vendor_commit, build_id) DO UPDATE SET
        raw_manifest = EXCLUDED.raw_manifest,
        probe_environment = EXCLUDED.probe_environment,
        generated_at = EXCLUDED.generated_at,
        status = 'ready'
      RETURNING id
    `
    const manifestId = rows[0]?.id
    if (!manifestId) throw new Error('Capability manifest upsert returned no id')
    await transaction`DELETE FROM capabilities WHERE manifest_id = ${manifestId}`
    for (const capability of capabilities) {
      await transaction`
        INSERT INTO capabilities (
          id, manifest_id, kind, name, matrix_class, compiled, enabled,
          advertised_by_acp, invocable, ui_supported, tested, conditions,
          source_evidence, known_gap, last_test_result
        ) VALUES (
          ${String(capability.id)}, ${manifestId}, ${String(capability.kind)},
          ${String(capability.name)}, ${String(capability.matrix_class)},
          ${capability.compiled === true}, ${capability.enabled === true},
          ${capability.advertised_by_acp === true},
          ${typeof capability.invocable === 'boolean' ? capability.invocable : null},
          ${capability.ui_supported === true}, ${capability.tested === true},
          ${transaction.json((capability.conditions ?? []) as JsonValue)},
          ${transaction.json((capability.source_evidence ?? []) as JsonValue)},
          ${typeof capability.known_gap === 'string' ? capability.known_gap : null},
          ${String(capability.last_test_result ?? 'not_tested')}
        )
      `
    }
  })
}
await persistManifest()

interface ProviderProfileConfig extends Omit<ProviderProfile, 'credentialStatus' | 'active'> {}

async function providerProfiles(): Promise<ProviderProfile[]> {
  const file = Bun.file(providerProfilesPath)
  if (!await file.exists()) throw new Error(`Provider profiles missing: ${providerProfilesPath}`)
  const document = await file.json() as { profiles?: ProviderProfileConfig[] }
  const rows = await database<{ name: string; credential_status: string; enabled: boolean }[]>`
    SELECT name, credential_status, enabled FROM integrations WHERE kind = 'provider'
  `
  const observed = new Map(rows.map(row => [row.name, row]))
  return (document.profiles ?? []).map(profile => {
    const state = observed.get(profile.id)
    return {
      ...profile,
      active: state?.enabled === true,
      credentialStatus: state?.credential_status === 'configured' ? 'configured' : 'missing',
    }
  })
}

const encoder = new TextEncoder()
const subscribers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>()
let workerSocket: Bun.ServerWebSocket<{ workerId: string | null }> | null = null
let workerMessageQueue = Promise.resolve()

function sseFrame(event: HarnessEvent): Uint8Array {
  return encoder.encode(
    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  )
}

function broadcast(event: HarnessEvent): void {
  for (const controller of subscribers.get(event.sessionId) ?? []) {
    try {
      controller.enqueue(sseFrame(event))
    } catch {
      subscribers.get(event.sessionId)?.delete(controller)
    }
  }
}

function sendWorker(message: GatewayToWorkerMessage): boolean {
  if (!workerSocket || workerSocket.readyState !== WebSocket.OPEN) return false
  workerSocket.send(JSON.stringify(message))
  return true
}

async function deliver(command: WorkerCommand): Promise<boolean> {
  const sent = sendWorker({ kind: 'command', command })
  if (sent) await store.markCommandDelivered(command.id)
  return sent
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key')?.trim()
  return value && value.length <= 200 ? value : null
}

function apiError(message: string, status: 400 | 404 | 409 | 503) {
  return Response.json({ error: message }, { status })
}

const app = new Hono()

app.get('/healthz', c => c.json({ service: 'gateway', status: 'ok' }))
app.get('/health/live', c => c.json({ service: 'gateway', status: 'ok' }))
app.get('/readyz', async c => {
  await database`SELECT 1`
  return c.json({
    service: 'gateway',
    status: 'ok',
    database: 'ready',
    workerOnline: workerSocket?.readyState === WebSocket.OPEN,
    vendorAccess: false,
    dockerSocketMounted: false,
  })
})
app.get('/health/ready', async c => {
  await database`SELECT 1`
  return c.json({ service: 'gateway', status: 'ok', database: 'ready' })
})

app.get('/api/session', async c => {
  const session = await store.getActiveSession()
  const events = session ? await store.listEvents(session.id) : []
  const snapshot: SessionSnapshot = {
    session,
    events,
    workerOnline: workerSocket?.readyState === WebSocket.OPEN,
  }
  return c.json(snapshot)
})

app.get('/api/capabilities', async c => {
  const rows = await database<{ raw_manifest: Record<string, unknown> }[]>`
    SELECT raw_manifest FROM capability_manifests
    WHERE status = 'ready' ORDER BY generated_at DESC LIMIT 1
  `
  const manifest = rows[0]?.raw_manifest
  if (!manifest) return apiError('Capability manifest is unavailable', 503)
  const view: CapabilityView = {
    vendorCommit: String(manifest.vendor_commit),
    generatedAt: String(manifest.generated_at),
    summary: (manifest.summary ?? {}) as Record<string, JsonValue>,
    capabilities: Array.isArray(manifest.capabilities)
      ? manifest.capabilities as Array<Record<string, JsonValue>>
      : [],
    knownGaps: Array.isArray(manifest.known_gaps) ? manifest.known_gaps as JsonValue[] : [],
    providers: await providerProfiles(),
  }
  return c.json(view)
})

app.post('/api/sessions', async c => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return apiError('Idempotency-Key header is required', 400)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const permissionMode = typeof body.permissionMode === 'string'
    ? body.permissionMode
    : 'acceptEdits'
  const modelId = typeof body.modelId === 'string' ? body.modelId : null
  try {
    const result = await store.createSession({
      sessionId: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
      idempotencyKey: key,
      workspaceId: WORKSPACE_ID,
      permissionMode,
      modelId,
      workspacePath,
    })
    if (!result.created) return c.json({ session: result.session }, 200)
    const event = await store.appendEvent({
      id: crypto.randomUUID(),
      sessionId: result.session.id,
      turnId: null,
      type: 'session.created',
      payload: { status: result.session.status },
      source: 'gateway',
    })
    broadcast(event)
    await deliver(result.command)
    return c.json({ session: result.session }, 201)
  } catch (error) {
    if ((error as Error).message === 'ACTIVE_SESSION_EXISTS') {
      return apiError('Only one active session is supported by this Worker', 409)
    }
    throw error
  }
})

app.post('/api/sessions/:sessionId/prompts', async c => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return apiError('Idempotency-Key header is required', 400)
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return apiError('Prompt text is required', 400)
  const sessionId = c.req.param('sessionId')
  const turnId = crypto.randomUUID()
  try {
    const result = await store.createPrompt({
      sessionId,
      turnId,
      commandId: crypto.randomUUID(),
      idempotencyKey: key,
      text,
    })
    const command = result.command
    if (!result.created) return c.json({ turnId: command.payload.turnId }, 202)
    const event = await store.appendEvent({
      id: crypto.randomUUID(),
      sessionId,
      turnId: command.payload.turnId,
      type: 'user.message_created',
      payload: { text },
      source: 'browser',
    })
    broadcast(event)
    if (!await deliver(command)) return apiError('Worker is offline', 503)
    return c.json({ turnId: command.payload.turnId }, 202)
  } catch (error) {
    const message = (error as Error).message
    if (message === 'SESSION_NOT_FOUND') return apiError('Session not found', 404)
    if (message === 'SESSION_NOT_READY') return apiError('Session cannot accept prompts', 409)
    throw error
  }
})

async function controlCommand(input: {
  request: Request
  sessionId: string
  type: 'resolve_permission' | 'set_mode' | 'set_model'
  payload: Record<string, JsonValue>
}): Promise<Response> {
  const key = idempotencyKey(input.request)
  if (!key) return apiError('Idempotency-Key header is required', 400)
  try {
    const result = await store.createControlCommand({
      sessionId: input.sessionId,
      commandId: crypto.randomUUID(),
      idempotencyKey: key,
      type: input.type,
      payload: input.payload,
    })
    if (result.created && !await deliver(result.command)) return apiError('Worker is offline', 503)
    return Response.json({ status: 'accepted' }, { status: 202 })
  } catch (error) {
    const message = (error as Error).message
    if (message === 'SESSION_NOT_FOUND') return apiError('Session not found', 404)
    if (message === 'SESSION_NOT_IDLE') return apiError('Session must be idle', 409)
    if (message === 'PERMISSION_NOT_PENDING') {
      return apiError('Permission request is no longer pending', 409)
    }
    throw error
  }
}

app.post('/api/sessions/:sessionId/permissions/:permissionId/resolve', async c => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const optionId = typeof body.optionId === 'string' ? body.optionId : ''
  if (!optionId) return apiError('Permission option is required', 400)
  return controlCommand({
    request: c.req.raw,
    sessionId: c.req.param('sessionId'),
    type: 'resolve_permission',
    payload: {
      permissionRequestId: c.req.param('permissionId'),
      optionId,
    },
  })
})

app.post('/api/sessions/:sessionId/questions/:permissionId/answer', async c => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
    ? body.answers as Record<string, string>
    : {}
  if (Object.keys(answers).length === 0 || Object.values(answers).some(value => typeof value !== 'string')) {
    return apiError('At least one question answer is required', 400)
  }
  return controlCommand({
    request: c.req.raw,
    sessionId: c.req.param('sessionId'),
    type: 'resolve_permission',
    payload: {
      permissionRequestId: c.req.param('permissionId'),
      optionId: 'allow',
      answers,
    },
  })
})

app.post('/api/sessions/:sessionId/mode', async c => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const modeId = typeof body.modeId === 'string' ? body.modeId : ''
  if (!modeId) return apiError('Mode is required', 400)
  const session = await store.getSession(c.req.param('sessionId'))
  if (!session) return apiError('Session not found', 404)
  if (!session.availableModes.some(mode => mode.id === modeId)) return apiError('Mode is unavailable', 400)
  return controlCommand({
    request: c.req.raw,
    sessionId: session.id,
    type: 'set_mode',
    payload: { modeId },
  })
})

app.post('/api/sessions/:sessionId/model', async c => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const modelId = typeof body.modelId === 'string' ? body.modelId : ''
  if (!modelId) return apiError('Model is required', 400)
  const session = await store.getSession(c.req.param('sessionId'))
  if (!session) return apiError('Session not found', 404)
  if (!session.availableModels.some(model => model.modelId === modelId)) {
    return apiError('Model is unavailable', 400)
  }
  return controlCommand({
    request: c.req.raw,
    sessionId: session.id,
    type: 'set_model',
    payload: { modelId },
  })
})

app.post('/api/sessions/:sessionId/cancel', async c => {
  const key = idempotencyKey(c.req.raw)
  if (!key) return apiError('Idempotency-Key header is required', 400)
  try {
    const result = await store.createCancel({
      sessionId: c.req.param('sessionId'),
      commandId: crypto.randomUUID(),
      idempotencyKey: key,
    })
    const command = result.command
    if (result.created && !await deliver(command)) return apiError('Worker is offline', 503)
    return c.json({ status: 'cancelling' }, 202)
  } catch (error) {
    const message = (error as Error).message
    if (message === 'SESSION_NOT_FOUND') return apiError('Session not found', 404)
    if (message === 'SESSION_NOT_RUNNING') return apiError('Session is not running', 409)
    throw error
  }
})

app.get('/api/sessions/:sessionId/events', async c => {
  const sessionId = c.req.param('sessionId')
  const session = await store.getSession(sessionId)
  if (!session) return apiError('Session not found', 404)
  const afterSeq = Number.parseInt(c.req.header('last-event-id') ?? '0', 10) || 0
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controllerRef = controller
      for (const event of await store.listEvents(sessionId, afterSeq)) {
        controller.enqueue(sseFrame(event))
      }
      const sessionSubscribers = subscribers.get(sessionId) ?? new Set()
      sessionSubscribers.add(controller)
      subscribers.set(sessionId, sessionSubscribers)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
          sessionSubscribers.delete(controller)
        }
      }, 15_000)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      if (controllerRef) subscribers.get(sessionId)?.delete(controllerRef)
    },
  })
  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
})

app.get('*', async c => {
  const requestedPath = new URL(c.req.url).pathname
  const safePath = requestedPath.startsWith('/assets/')
    ? requestedPath
    : '/index.html'
  const file = Bun.file(`${webRoot}${safePath}`)
  if (!await file.exists()) return c.text('DeepHarness web build not found', 503)
  return new Response(file, {
    headers: {
      'content-type': file.type || (safePath.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : 'application/octet-stream'),
    },
  })
})

const server = Bun.serve<{ workerId: string | null }>({
  hostname: '0.0.0.0',
  port,
  idleTimeout: 30,
  async fetch(request, bunServer) {
    const url = new URL(request.url)
    if (url.pathname === '/internal/worker') {
      if (url.searchParams.get('token') !== workerToken) {
        return new Response('Unauthorized', { status: 401 })
      }
      const upgraded = bunServer.upgrade(request, { data: { workerId: null } })
      return upgraded ? undefined : new Response('Upgrade failed', { status: 400 })
    }
    return app.fetch(request)
  },
  websocket: {
    open(socket) {
      if (workerSocket && workerSocket !== socket) workerSocket.close(1012, 'Worker replaced')
      workerSocket = socket
    },
    message(socket, raw) {
      workerMessageQueue = workerMessageQueue.then(async () => {
        const message = JSON.parse(String(raw)) as WorkerToGatewayMessage
        if (message.kind === 'register') {
          socket.data.workerId = message.worker.id
          await store.registerWorker(message.worker)
          socket.send(JSON.stringify({ kind: 'registered', workerId: message.worker.id } satisfies GatewayToWorkerMessage))
          for (const command of await store.pendingCommands()) await deliver(command)
          return
        }
        if (message.kind === 'command_result') {
          await store.markCommandResult(message.commandId, message.ok)
          return
        }
        if (message.kind === 'event') {
          const event = await store.appendEvent({
            ...message.event,
            source: 'worker',
          })
          await store.applyWorkerEvent(event)
          broadcast(event)
        }
      }).catch(error => {
        console.error(JSON.stringify({
          service: 'gateway',
          event: 'worker_message_failed',
          error: error instanceof Error ? error.message : String(error),
        }))
      })
    },
    async close(socket) {
      if (workerSocket === socket) workerSocket = null
      if (socket.data.workerId) await store.workerOffline(socket.data.workerId)
    },
  },
})

console.log(JSON.stringify({ service: 'gateway', event: 'started', port: server.port }))
