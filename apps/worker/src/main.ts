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
const workspacePath = process.env.WORKSPACE_PATH ?? '/workspace/source'
const vendorCommit = process.env.VENDOR_COMMIT ?? 'unknown'
const outbound: WorkerToGatewayMessage[] = []
let socket: WebSocket | null = null
let registered = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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
        name: 'DeepHarness phase 2 worker',
        maxConcurrency: 1,
        workspacePath,
        version: '0.2.0',
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
      void supervisor.handle(message.command)
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
  fetch(request) {
    const path = new URL(request.url).pathname
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
        dockerSocketMounted: false,
      }, { status: registered ? 200 : 503 })
    }
    return new Response('DeepHarness Worker\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
})

function shutdown(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  supervisor.shutdown()
  socket?.close(1001, 'Worker shutting down')
  server.stop(true)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log(JSON.stringify({ service: 'worker', event: 'started', port: server.port }))
