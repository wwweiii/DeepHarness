import type {
  GatewayToWorkerMessage,
  WorkerToGatewayMessage,
} from '@deepharness/protocol'
import { activeProviderStatus } from './provider.ts'
import { WorkerSupervisor } from './supervisor.ts'

const port = Number.parseInt(process.env.PORT ?? '8081', 10)
const gatewayUrl = process.env.GATEWAY_URL ?? 'http://gateway:8080'
const workerToken = process.env.WORKER_SHARED_TOKEN ?? 'phase-1-local-token'
const workerId = process.env.WORKER_ID ?? 'phase-1-worker'
const workspaceRoots = (process.env.WORKSPACE_ROOTS ?? process.env.WORKSPACE_PATH ?? '/workspace/source')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const vendorCommit = process.env.VENDOR_COMMIT ?? 'unknown'
const outbound: WorkerToGatewayMessage[] = []
let socket: WebSocket | null = null
let registered = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let commandQueue = Promise.resolve()
let shuttingDown = false

function send(message: WorkerToGatewayMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  else outbound.push(message)
}

const supervisor = new WorkerSupervisor(send)
const provider = activeProviderStatus()

function connect(): void {
  const url = new URL('/internal/worker', gatewayUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('token', workerToken)
  socket = new WebSocket(url)
  socket.addEventListener('open', () => {
    send({
      kind: 'register',
      worker: {
        id: workerId,
        name: 'DeepHarness phase 3 worker',
        maxConcurrency: supervisor.concurrency,
        workspaceRoots,
        version: '0.3.0',
        vendorCommit,
        providerId: provider.providerId,
        credentialStatus: provider.credentialStatus,
      },
    })
    while (outbound.length > 0 && socket?.readyState === WebSocket.OPEN) {
      const message = outbound.shift()
      if (message) socket.send(JSON.stringify(message))
    }
  })
  socket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data)) as GatewayToWorkerMessage
      if (message.kind === 'registered') {
        registered = true
        return
      }
      commandQueue = commandQueue
        .then(() => supervisor.handle(message.command))
        .catch(error => console.error(JSON.stringify({
          service: 'worker',
          event: 'command_failed',
          error: error instanceof Error ? error.message : String(error),
        })))
    } catch (error) {
      console.error(JSON.stringify({
        service: 'worker',
        event: 'gateway_message_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  })
  socket.addEventListener('close', () => {
    socket = null
    registered = false
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, 1_000)
    }
  })
  socket.addEventListener('error', () => socket?.close())
}

connect()

const server = Bun.serve({
  hostname: '0.0.0.0',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === '/healthz' || path === '/health/live') {
      return Response.json({ service: 'worker', status: 'ok' })
    }
    if (path === '/readyz' || path === '/health/ready') {
      return Response.json({
        service: 'worker',
        status: registered ? 'ok' : 'starting',
        gateway: registered ? 'connected' : 'disconnected',
        agentBoundary: 'acp-stdio',
        processIsolation: 'one-active-session-per-process',
        maxConcurrency: supervisor.concurrency,
        activeProcesses: supervisor.activeProcessCount,
        queuedProcesses: supervisor.queuedProcessCount,
        dockerSocketMounted: false,
      }, { status: registered ? 200 : 503 })
    }
    if (path.startsWith('/internal/test/crash/') && process.env.ENABLE_TEST_CONTROL === '1') {
      if (request.headers.get('x-worker-token') !== workerToken) {
        return new Response('Unauthorized', { status: 401 })
      }
      const sessionId = decodeURIComponent(path.slice('/internal/test/crash/'.length))
      return Response.json({ crashed: supervisor.crashSessionForTest(sessionId) })
    }
    if (path.startsWith('/internal/test/stop/') && process.env.ENABLE_TEST_CONTROL === '1') {
      if (request.headers.get('x-worker-token') !== workerToken) {
        return new Response('Unauthorized', { status: 401 })
      }
      const sessionId = decodeURIComponent(path.slice('/internal/test/stop/'.length))
      return Response.json({ stopped: supervisor.stopSessionForTest(sessionId) })
    }
    if (path.startsWith('/internal/test/transcript/') && process.env.ENABLE_TEST_CONTROL === '1') {
      if (request.headers.get('x-worker-token') !== workerToken) {
        return new Response('Unauthorized', { status: 401 })
      }
      const parts = path.slice('/internal/test/transcript/'.length).split('/')
      const action = parts[0]
      const sessionId = decodeURIComponent(parts.slice(1).join('/'))
      if ((action !== 'delete' && action !== 'corrupt') || !sessionId) {
        return new Response('Invalid transcript action', { status: 400 })
      }
      return Response.json({
        damaged: await supervisor.damageTranscriptForTest(sessionId, action),
      })
    }
    return new Response('DeepHarness Worker\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
})

async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  socket?.close(1001, 'Worker shutting down')
  server.stop(true)
  await supervisor.shutdown()
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

console.log(JSON.stringify({ service: 'worker', event: 'started', port: server.port }))
