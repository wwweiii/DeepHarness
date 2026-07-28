import type {
  HarnessEvent,
  SessionRecord,
  SessionSnapshot,
} from '@deepharness/protocol'
import { Activity, Box, CirclePlus, Radio, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Thread } from '../features/chat/messages/Thread.tsx'
import { HarnessRuntimeProvider } from '../features/chat/runtime/HarnessRuntimeProvider.tsx'
import type { HarnessProjection } from '../features/chat/runtime/reducer.ts'
import { requestId } from '../lib/requestId.ts'

interface LiveState {
  projection: HarnessProjection
  connected: boolean
}

const initialProjection: HarnessProjection = {
  messages: [],
  status: 'queued',
  error: null,
  usage: null,
}

async function createSession(): Promise<void> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': requestId(),
    },
    body: JSON.stringify({ permissionMode: 'acceptEdits' }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? 'Unable to create session')
  }
}

function statusLabel(status: HarnessProjection['status']): string {
  return status.replace('_', ' ')
}

function Shell({
  session,
  initialEvents,
  workerOnline,
}: {
  session: SessionRecord
  initialEvents: HarnessEvent[]
  workerOnline: boolean
}) {
  const [live, setLive] = useState<LiveState>({
    projection: initialProjection,
    connected: false,
  })
  const onProjection = useCallback((value: {
    projection: HarnessProjection
    connected: boolean
  }) => {
    setLive(current => (
      current.projection === value.projection && current.connected === value.connected
        ? current
        : { projection: value.projection, connected: value.connected }
    ))
  }, [])
  const isRunning = live.projection.status === 'running'
    || live.projection.status === 'cancelling'

  const cancel = async () => {
    await fetch(`/api/sessions/${session.id}/cancel`, {
      method: 'POST',
      headers: { 'idempotency-key': requestId() },
    })
  }

  return (
    <HarnessRuntimeProvider
      sessionId={session.id}
      initialEvents={initialEvents}
      onProjection={onProjection}
    >
      <div className="app-shell">
        <aside className="session-rail">
          <div className="brand-lockup">
            <div className="brand-mark">DH</div>
            <div>
              <strong>DeepHarness</strong>
              <span>Agent control plane</span>
            </div>
          </div>
          <button className="new-session-button" disabled title="Phase 1 allows one active session">
            <CirclePlus size={17} aria-hidden="true" />
            New session
          </button>
          <div className="rail-label">Sessions</div>
          <button className="session-item active">
            <span className={`status-dot status-${live.projection.status}`} />
            <span>
              <strong>{session.title}</strong>
              <small>{statusLabel(live.projection.status)}</small>
            </span>
          </button>
          <div className="rail-footer">
            <Box size={16} aria-hidden="true" />
            Shared workspace
          </div>
        </aside>

        <main className="workbench">
          <header className="workbench-header">
            <div>
              <span className="mobile-brand">DeepHarness</span>
              <h1>{session.title}</h1>
              <p>Shared workspace</p>
            </div>
            <div className="header-actions">
              <span className={`connection-state ${workerOnline && live.connected ? 'online' : 'offline'}`}>
                <Radio size={15} aria-hidden="true" />
                {workerOnline && live.connected ? 'Connected' : 'Reconnecting'}
              </span>
              <button
                className="icon-button stop-button"
                title="Stop generation"
                disabled={!isRunning}
                onClick={() => void cancel()}
              >
                <Square size={16} fill="currentColor" aria-hidden="true" />
                <span className="sr-only">Stop generation</span>
              </button>
            </div>
          </header>
          {live.projection.error && (
            <div className="error-banner" role="alert">{live.projection.error}</div>
          )}
          {!workerOnline && (
            <div className="offline-banner" role="status">Worker is offline. History remains available.</div>
          )}
          <Thread isRunning={isRunning} />
        </main>

        <aside className="inspector">
          <div className="inspector-title">
            <Activity size={17} aria-hidden="true" />
            <strong>Session</strong>
          </div>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{statusLabel(live.projection.status)}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{session.permissionMode}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{session.modelId || 'Vendor default'}</dd>
            </div>
            <div>
              <dt>Events</dt>
              <dd>{initialEvents.length + Math.max(0, live.projection.messages.length - 1)}</dd>
            </div>
          </dl>
          {live.projection.usage && (
            <div className="usage-block">
              <span>Latest usage</span>
              <code>{JSON.stringify(live.projection.usage)}</code>
            </div>
          )}
        </aside>
      </div>
    </HarnessRuntimeProvider>
  )
}

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/session')
    if (!response.ok) throw new Error('Gateway is unavailable')
    setSnapshot(await response.json() as SessionSnapshot)
  }, [])

  useEffect(() => {
    void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [load])

  const initialEvents = useMemo(() => snapshot?.events ?? [], [snapshot?.events])

  if (!snapshot) {
    return <div className="loading-screen">{error ?? 'Loading DeepHarness...'}</div>
  }
  if (!snapshot.session) {
    return (
      <main className="setup-screen">
        <div className="setup-brand">DH</div>
        <h1>DeepHarness</h1>
        <p>Shared workspace is ready for one Agent session.</p>
        {error && <div className="setup-error">{error}</div>}
        <button
          className="primary-command"
          disabled={creating || !snapshot.workerOnline}
          onClick={() => {
            setCreating(true)
            setError(null)
            void createSession()
              .then(load)
              .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setCreating(false))
          }}
        >
          <CirclePlus size={18} aria-hidden="true" />
          {creating ? 'Starting...' : 'Create session'}
        </button>
        {!snapshot.workerOnline && <span className="setup-wait">Waiting for Worker</span>}
      </main>
    )
  }

  return (
    <Shell
      session={snapshot.session}
      initialEvents={initialEvents}
      workerOnline={snapshot.workerOnline}
    />
  )
}
