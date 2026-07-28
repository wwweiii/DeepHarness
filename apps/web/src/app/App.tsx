import type {
  HarnessEvent,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'
import {
  Activity,
  Blocks,
  Box,
  CirclePlus,
  GitFork,
  MessagesSquare,
  Radio,
  RefreshCw,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { CapabilityPage } from '../features/capabilities/CapabilityPage.tsx'
import { Thread } from '../features/chat/messages/Thread.tsx'
import { HarnessRuntimeProvider } from '../features/chat/runtime/HarnessRuntimeProvider.tsx'
import type { HarnessProjection } from '../features/chat/runtime/reducer.ts'
import { requestId } from '../lib/requestId.ts'

interface LiveState {
  projection: HarnessProjection
  connected: boolean
}

interface SessionCatalog {
  sessions: SessionRecord[]
}

interface WorkspaceCatalog {
  workspaces: WorkspaceRecord[]
}

const selectedSessionStorageKey = 'deepharness.selectedSessionId'

function initialSelectedSessionId(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('sessionId')
  if (fromUrl) return fromUrl
  try {
    return window.localStorage.getItem(selectedSessionStorageKey)
  } catch {
    return null
  }
}

function persistSelectedSessionId(sessionId: string | null): void {
  const url = new URL(window.location.href)
  if (sessionId) url.searchParams.set('sessionId', sessionId)
  else url.searchParams.delete('sessionId')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  try {
    if (sessionId) window.localStorage.setItem(selectedSessionStorageKey, sessionId)
    else window.localStorage.removeItem(selectedSessionStorageKey)
  } catch {
    // URL persistence remains available when browser storage is disabled.
  }
}

function projectionFromSession(session: SessionRecord): HarnessProjection {
  return {
    messages: [],
    status: session.status,
    error: session.recoveryError,
    usage: null,
    plan: [],
    permissionMode: session.permissionMode,
    modelId: session.modelId,
    promptQueueDepth: session.promptQueueDepth,
    processState: session.processState,
    recoveryStrategy: session.recoveryStrategy,
    recoveryError: session.recoveryError,
    contextState: session.contextState,
    eventCount: 0,
    availableModes: session.availableModes,
    availableModels: session.availableModels,
  }
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`)
  return body
}

async function command<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return json<T>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': requestId(),
    },
    body: JSON.stringify(body),
  })
}

function statusLabel(status: HarnessProjection['status']): string {
  return status.replaceAll('_', ' ')
}

function Shell({
  session,
  sessions,
  workspace,
  workspaces,
  initialEvents,
  workerOnline,
  onSelectSession,
  onReload,
}: {
  session: SessionRecord
  sessions: SessionRecord[]
  workspace: WorkspaceRecord | null
  workspaces: WorkspaceRecord[]
  initialEvents: HarnessEvent[]
  workerOnline: boolean
  onSelectSession: (sessionId: string) => void
  onReload: (sessionId?: string) => Promise<void>
}) {
  const [live, setLive] = useState<LiveState>({
    projection: projectionFromSession(session),
    connected: false,
  })
  const [view, setView] = useState<'chat' | 'capabilities'>('chat')
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const onProjection = useCallback((value: LiveState) => setLive(value), [])
  const isRunning = ['running', 'cancelling'].includes(live.projection.status)

  const run = async (action: () => Promise<string | void>) => {
    setBusy(true)
    setActionError(null)
    try {
      const nextSessionId = await action()
      await onReload(nextSessionId || session.id)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    await command(`/api/sessions/${session.id}/cancel`)
  }
  const changeConfiguration = async (kind: 'mode' | 'model', value: string) => {
    await command(`/api/sessions/${session.id}/${kind}`,
      kind === 'mode' ? { modeId: value } : { modelId: value })
  }
  const modes = live.projection.availableModes.length > 0
    ? live.projection.availableModes
    : session.availableModes
  const models = live.projection.availableModels.length > 0
    ? live.projection.availableModels
    : session.availableModels
  const currentMode = live.projection.permissionMode ?? session.permissionMode
  const currentModel = live.projection.modelId ?? session.modelId
  const forkWorkspace = workspaces.find(candidate => candidate.id === workspaceId && candidate.mode === 'worktree')

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
            <div><strong>DeepHarness</strong><span>Agent control plane</span></div>
          </div>
          <div className="session-create-controls">
            <select
              aria-label="New session workspace"
              value={workspaceId}
              onChange={event => setWorkspaceId(event.target.value)}
            >
              {workspaces.map(item => (
                <option key={item.id} value={item.id}>{item.name} ({item.mode})</option>
              ))}
            </select>
            <button
              className="new-session-button"
              disabled={busy || !workerOnline || !workspaceId}
              onClick={() => void run(async () => {
                const result = await command<{ session: SessionRecord }>('/api/sessions', {
                  permissionMode: 'default',
                  workspaceId,
                })
                return result.session.id
              })}
            >
              <CirclePlus size={17} aria-hidden="true" />
              New session
            </button>
          </div>
          <div className="rail-label">Sessions</div>
          <div className="session-list">
            {sessions.map(item => (
              <button
                key={item.id}
                data-session-id={item.id}
                className={item.id === session.id ? 'session-item active' : 'session-item'}
                onClick={() => onSelectSession(item.id)}
              >
                <span className={`status-dot status-${item.status}`} />
                <span><strong>{item.title}</strong><small>{statusLabel(item.status)}</small></span>
              </button>
            ))}
          </div>
          <div className="rail-label">Views</div>
          <button className={view === 'chat' ? 'view-item active' : 'view-item'} onClick={() => setView('chat')}>
            <MessagesSquare size={16} /> Chat
          </button>
          <button className={view === 'capabilities' ? 'view-item active' : 'view-item'} onClick={() => setView('capabilities')}>
            <Blocks size={16} /> Capabilities
          </button>
          <div className="rail-footer">
            <Box size={16} aria-hidden="true" />
            <span>{workspace?.name ?? 'Workspace unavailable'}<small>{workspace?.mode ?? 'unknown'}</small></span>
          </div>
        </aside>

        <main className={`workbench workbench-${view}`}>
          <div className="mobile-view-tabs">
            <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>Chat</button>
            <button className={view === 'capabilities' ? 'active' : ''} onClick={() => setView('capabilities')}>Capabilities</button>
          </div>
          {view === 'chat' ? <>
            <header className="workbench-header">
              <div>
                <span className="mobile-brand">DeepHarness</span>
                <h1>{session.title}</h1>
                <p>{workspace?.name ?? session.workspaceId}</p>
              </div>
              <div className="header-actions">
                <span className={`connection-state ${workerOnline && live.connected ? 'online' : 'offline'}`}>
                  <Radio size={15} aria-hidden="true" />
                  {workerOnline && live.connected ? 'Connected' : 'Reconnecting'}
                </span>
                <button
                  className="icon-button"
                  title="Fork session"
                  disabled={busy || !forkWorkspace || !session.agentSessionId}
                  onClick={() => void run(async () => {
                    const result = await command<{ session: SessionRecord }>(`/api/sessions/${session.id}/fork`, {
                      workspaceId: forkWorkspace?.id,
                    })
                    return result.session.id
                  })}
                >
                  <GitFork size={16} aria-hidden="true" />
                  <span className="sr-only">Fork session</span>
                </button>
                <button
                  className="icon-button stop-button"
                  title="Stop generation"
                  disabled={!isRunning}
                  onClick={() => void cancel()}
                >
                  <Square size={16} fill="currentColor" aria-hidden="true" />
                  <span className="sr-only">Stop generation</span>
                </button>
                <button
                  className="icon-button"
                  title="Close session"
                  disabled={busy || session.status === 'closed'}
                  onClick={() => void run(async () => {
                    await command(`/api/sessions/${session.id}/close`)
                  })}
                >
                  <X size={17} aria-hidden="true" />
                  <span className="sr-only">Close session</span>
                </button>
              </div>
            </header>
            {(live.projection.error || actionError) && (
              <div className="error-banner" role="alert">{actionError ?? live.projection.error}</div>
            )}
            {!workerOnline && (
              <div className="offline-banner" role="status">Worker is offline. History remains available.</div>
            )}
            {live.projection.status === 'recovery_required' && (
              <div className="recovery-banner" role="status">
                <span>{live.projection.recoveryError ?? session.recoveryError ?? 'Recovery needs attention.'}</span>
                <button disabled={busy} onClick={() => void run(async () => {
                  await command(`/api/sessions/${session.id}/recover`, { strategy: 'resume' })
                })}><RefreshCw size={15} /> Resume</button>
                <button disabled={busy} onClick={() => void run(async () => {
                  await command(`/api/sessions/${session.id}/recover`, { strategy: 'load' })
                })}>Load</button>
              </div>
            )}
            <Thread isRunning={isRunning} sessionId={session.id} />
          </> : <CapabilityPage />}
        </main>

        <aside className="inspector">
          <div className="inspector-title"><Activity size={17} aria-hidden="true" /><strong>Session</strong></div>
          <dl>
            <div><dt>Status</dt><dd>{statusLabel(live.projection.status)}</dd></div>
            <div><dt>Process</dt><dd>{live.projection.processState}</dd></div>
            <div><dt>Recovery</dt><dd>{live.projection.recoveryStrategy ?? 'new'}</dd></div>
            <div>
              <dt>Mode</dt>
              <dd><select
                aria-label="Permission mode"
                value={currentMode}
                disabled={live.projection.status !== 'idle' || live.projection.processState !== 'running'}
                onChange={event => void changeConfiguration('mode', event.target.value)}
              >
                {modes.map(mode => <option key={mode.id} value={mode.id}>{mode.name}</option>)}
                {modes.length === 0 && <option value={currentMode}>{currentMode}</option>}
              </select></dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd><select
                aria-label="Model"
                value={currentModel ?? ''}
                disabled={live.projection.status !== 'idle' || live.projection.processState !== 'running'}
                onChange={event => void changeConfiguration('model', event.target.value)}
              >
                {models.map(model => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
                {models.length === 0 && <option value={currentModel ?? ''}>{currentModel || 'Vendor default'}</option>}
              </select></dd>
            </div>
            <div><dt>Provider</dt><dd>{session.providerId}</dd></div>
            <div><dt>Workspace</dt><dd>{workspace?.mode ?? 'unknown'}</dd></div>
            <div><dt>Prompt queue</dt><dd>{live.projection.promptQueueDepth}</dd></div>
            <div><dt>Events</dt><dd>{live.projection.eventCount}</dd></div>
          </dl>
          {live.projection.usage && (
            <div className="usage-block">
              <span>Latest usage</span>
              <dl className="usage-values">
                {Object.entries(live.projection.usage).map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
                ))}
                {!('costUsd' in live.projection.usage) && <div><dt>costUsd</dt><dd>Unavailable from ACP</dd></div>}
              </dl>
            </div>
          )}
        </aside>
      </div>
    </HarnessRuntimeProvider>
  )
}

export function App() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialSelectedSessionId)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (sessionId?: string) => {
    const [sessionCatalog, workspaceCatalog] = await Promise.all([
      json<SessionCatalog>('/api/sessions'),
      json<WorkspaceCatalog>('/api/workspaces'),
    ])
    const requested = sessionId ?? selectedSessionId
    const nextSnapshot = await json<SessionSnapshot>(
      requested ? `/api/session?sessionId=${encodeURIComponent(requested)}` : '/api/session',
    )
    setSessions(sessionCatalog.sessions)
    setWorkspaces(workspaceCatalog.workspaces)
    setSelectedWorkspaceId(current => current || workspaceCatalog.workspaces[0]?.id || '')
    const nextSessionId = nextSnapshot.session?.id ?? null
    setSelectedSessionId(nextSessionId)
    persistSelectedSessionId(nextSessionId)
    setSnapshot(nextSnapshot)
  }, [selectedSessionId])

  useEffect(() => {
    void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const initialEvents = useMemo(() => snapshot?.events ?? [], [snapshot?.events])

  if (!snapshot) return <div className="loading-screen">{error ?? 'Loading DeepHarness...'}</div>
  if (!snapshot.session) {
    return (
      <main className="setup-screen">
        <div className="setup-brand">DH</div>
        <h1>DeepHarness</h1>
        <select
          aria-label="Workspace"
          value={selectedWorkspaceId}
          onChange={event => setSelectedWorkspaceId(event.target.value)}
        >
          {workspaces.map(workspace => (
            <option key={workspace.id} value={workspace.id}>{workspace.name} ({workspace.mode})</option>
          ))}
        </select>
        {error && <div className="setup-error">{error}</div>}
        <button
          className="primary-command"
          disabled={creating || !snapshot.workerOnline || !selectedWorkspaceId}
          onClick={() => {
            setCreating(true)
            setError(null)
            void command<{ session: SessionRecord }>('/api/sessions', {
              permissionMode: 'default',
              workspaceId: selectedWorkspaceId,
            })
              .then(result => load(result.session.id))
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

  const workspace = workspaces.find(item => item.id === snapshot.session?.workspaceId) ?? null
  return (
    <Shell
      key={snapshot.session.id}
      session={snapshot.session}
      sessions={sessions}
      workspace={workspace}
      workspaces={workspaces}
      initialEvents={initialEvents}
      workerOnline={snapshot.workerOnline}
      onSelectSession={sessionId => void load(sessionId)}
      onReload={load}
    />
  )
}
