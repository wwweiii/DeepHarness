import { createDatabase, migrate } from '@deepharness/database'
import {
  WORKSPACE_ID,
  type GatewayToWorkerMessage,
  type HarnessEvent,
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

const database = createDatabase(databaseUrl)
await migrate(database)
const store = new GatewayStore(database)

async function persistManifest(): Promise<void> {
  const file = Bun.file(manifestPath)
  if (!await file.exists()) throw new Error(`Capability manifest missing: ${manifestPath}`)
  const manifest = await file.json() as Record<string, unknown>
  const probeEnvironment = JSON.parse(JSON.stringify(manifest.probe_environment))
  const rawManifest = JSON.parse(JSON.stringify(manifest))
  await database`
    INSERT INTO capability_manifests (
      id, vendor_commit, build_id, schema_version, probe_environment,
      raw_manifest, status, generated_at
    ) VALUES (
      ${crypto.randomUUID()}, ${String(manifest.vendor_commit)},
      ${String(manifest.build_id)}, ${Number(manifest.schema_version)},
      ${database.json(probeEnvironment)},
      ${database.json(rawManifest)}, 'ready', ${new Date(String(manifest.generated_at))}
    )
    ON CONFLICT (vendor_commit, build_id) DO UPDATE SET
      raw_manifest = EXCLUDED.raw_manifest,
      probe_environment = EXCLUDED.probe_environment,
      generated_at = EXCLUDED.generated_at,
      status = 'ready'
  `
}
await persistManifest()

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
      return apiError('Only one active session is supported in phase 1', 409)
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
    if (message === 'SESSION_NOT_IDLE') return apiError('Session is not idle', 409)
    throw error
  }
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
