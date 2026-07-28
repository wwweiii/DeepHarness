import type {
  AgentDefinitionSummary,
  HarnessEvent,
  SessionActivitySnapshot,
  SessionRecord,
  SessionSnapshot,
  WorkspaceRecord,
} from '@deepharness/protocol'
import {
  Activity,
  Blocks,
  Bot,
  Box,
  CirclePlus,
  GitFork,
  MessagesSquare,
  Network,
  Radio,
  RefreshCw,
  Square,
  ListTodo,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
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
    agents: [],
    tasks: [],
    teams: [],
    teamMessages: [],
    activityLimits: null,
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

type InspectorTab = 'overview' | 'agents' | 'tasks' | 'teams'

function ActivityInspector({
  session,
  workspace,
  projection,
  definitions,
  busy,
  onConfiguration,
  onStop,
}: {
  session: SessionRecord
  workspace: WorkspaceRecord | null
  projection: HarnessProjection
  definitions: AgentDefinitionSummary[]
  busy: boolean
  onConfiguration: (kind: 'mode' | 'model', value: string) => Promise<void>
  onStop: (kind: 'agents' | 'tasks', id: string) => Promise<void>
}) {
  const [tab, setTab] = useState<InspectorTab>('overview')
  const modes = projection.availableModes.length > 0 ? projection.availableModes : session.availableModes
  const models = projection.availableModels.length > 0 ? projection.availableModels : session.availableModels
  const currentMode = projection.permissionMode ?? session.permissionMode
  const currentModel = projection.modelId ?? session.modelId
  const agentDepth = (id: string): number => {
    let depth = 0
    let parent = projection.agents.find(agent => agent.id === id)?.parentAgentId ?? null
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      depth += 1
      parent = projection.agents.find(agent => agent.id === parent)?.parentAgentId ?? null
    }
    return depth
  }
  return (
    <aside className="inspector">
      <div className="inspector-title"><Activity size={17} aria-hidden="true" /><strong>Session</strong></div>
      <div className="inspector-tabs" role="tablist" aria-label="Session inspector">
        {(['overview', 'agents', 'tasks', 'teams'] as const).map(value => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >{value}</button>
        ))}
      </div>
      {tab === 'overview' && <>
        <dl>
          <div><dt>Status</dt><dd>{statusLabel(projection.status)}</dd></div>
          <div><dt>Process</dt><dd>{projection.processState}</dd></div>
          <div><dt>Recovery</dt><dd>{projection.recoveryStrategy ?? 'new'}</dd></div>
          <div>
            <dt>Mode</dt>
            <dd><select
              aria-label="Permission mode"
              value={currentMode}
              disabled={projection.status !== 'idle' || projection.processState !== 'running'}
              onChange={event => void onConfiguration('mode', event.target.value)}
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
              disabled={projection.status !== 'idle' || projection.processState !== 'running'}
              onChange={event => void onConfiguration('model', event.target.value)}
            >
              {models.map(model => <option key={model.modelId} value={model.modelId}>{model.name}</option>)}
              {models.length === 0 && <option value={currentModel ?? ''}>{currentModel || 'Vendor default'}</option>}
            </select></dd>
          </div>
          <div><dt>Provider</dt><dd>{session.providerId}</dd></div>
          <div><dt>Workspace</dt><dd>{workspace?.mode ?? 'unknown'}</dd></div>
          <div><dt>Prompt queue</dt><dd>{projection.promptQueueDepth}</dd></div>
          <div><dt>Events</dt><dd>{projection.eventCount}</dd></div>
        </dl>
        {projection.usage && (
          <div className="usage-block">
            <span>Latest usage</span>
            <dl className="usage-values">
              {Object.entries(projection.usage).map(([key, value]) => (
                <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>
              ))}
              {!('costUsd' in projection.usage) && <div><dt>costUsd</dt><dd>Unavailable from ACP</dd></div>}
            </dl>
          </div>
        )}
      </>}
      {tab === 'agents' && <div className="activity-panel" data-testid="agent-activity-panel">
        {projection.activityLimits && <div className="activity-limits">
          <span>{projection.activityLimits.activeAgents}/{projection.activityLimits.maxActiveAgents} active</span>
          <span>depth {projection.activityLimits.maxAgentDepth}</span>
          <span>{projection.activityLimits.observedAgentTokens}/{projection.activityLimits.maxAgentTokens} tokens</span>
        </div>}
        <section className="agent-definitions" data-testid="agent-definitions">
          <div className="activity-section-title">Agent definitions</div>
          {definitions.length === 0 && <p className="activity-empty">No definitions discovered</p>}
          {definitions.map(definition => <div key={definition.id} className="agent-definition-row">
            <div>
              <strong>{definition.name}</strong>
              <small>{definition.matrixClass} · {definition.tested ? 'tested' : 'not tested'}</small>
            </div>
            <span className={definition.enabled ? 'definition-enabled' : 'definition-disabled'}>
              {definition.enabled ? 'enabled' : 'disabled'}
            </span>
          </div>)}
        </section>
        {projection.agents.length === 0 && <p className="activity-empty">No sub-agents</p>}
        {projection.agents.map(agent => {
          const running = ['starting', 'running', 'stopping'].includes(agent.status)
          const lastTool = agent.metadata.lastToolCall as Record<string, unknown> | undefined
          return <div
            key={agent.id}
            className="activity-row agent-row"
            style={{ '--agent-depth': agentDepth(agent.id) } as CSSProperties}
            data-agent-id={agent.id}
          >
            <Bot size={15} aria-hidden="true" />
            <div className="activity-main">
              <strong>{agent.name ?? agent.agentType}</strong>
              <small>{agent.status}{agent.runInBackground ? ' · background' : ''}</small>
              {agent.description && <span>{agent.description}</span>}
              {lastTool && <code>{String(lastTool.toolName ?? 'tool')} · {String(lastTool.status ?? '')}</code>}
              {agent.output !== null && <pre>{typeof agent.output === 'string' ? agent.output : JSON.stringify(agent.output, null, 2)}</pre>}
            </div>
            {running && <button
              className="activity-stop"
              title="Stop agent"
              aria-label={`Stop ${agent.name ?? agent.agentType}`}
              disabled={busy || agent.status === 'stopping'}
              onClick={() => void onStop('agents', agent.id)}
            ><Square size={13} fill="currentColor" /></button>}
          </div>
        })}
      </div>}
      {tab === 'tasks' && <div className="activity-panel" data-testid="task-activity-panel">
        {projection.tasks.length === 0 && <p className="activity-empty">No tasks</p>}
        {projection.tasks.map(task => {
          const stoppable = Boolean(task.taskType) && ['pending', 'in_progress', 'stopping'].includes(task.status)
          return <div key={task.id} className="activity-row" data-task-id={task.id}>
            <ListTodo size={15} aria-hidden="true" />
            <div className="activity-main">
              <strong>{task.subject || `Task ${task.vendorTaskId}`}</strong>
              <small>{task.status}{task.owner ? ` · ${task.owner}` : ''}</small>
              {task.description && <span>{task.description}</span>}
              {task.output !== null && <pre>{typeof task.output === 'string' ? task.output : JSON.stringify(task.output, null, 2)}</pre>}
            </div>
            {stoppable && <button
              className="activity-stop"
              title="Stop task"
              aria-label={`Stop task ${task.vendorTaskId}`}
              disabled={busy || task.status === 'stopping'}
              onClick={() => void onStop('tasks', task.id)}
            ><Square size={13} fill="currentColor" /></button>}
          </div>
        })}
      </div>}
      {tab === 'teams' && <div className="activity-panel" data-testid="team-activity-panel">
        {projection.teams.length === 0 && <p className="activity-empty">No teams</p>}
        {projection.teams.map(team => <section key={team.id} className="team-section">
          <div className="activity-row">
            <Network size={15} aria-hidden="true" />
            <div className="activity-main"><strong>{team.name}</strong><small>{team.status} · {team.peers.length} peers</small></div>
          </div>
          {team.peers.map(peer => <div key={peer.id} className="peer-route">
            <span>{peer.name}</span><code>{peer.address ?? peer.agentId ?? peer.role}</code><small>{peer.status}</small>
          </div>)}
        </section>)}
        {projection.teamMessages.map(message => <div key={message.id} className="team-message">
          <code>{message.sender} → {message.recipient}</code>
          <span>{message.summary ?? (typeof message.content === 'string' ? message.content : message.messageType)}</span>
          <small>{message.deliveryStatus}</small>
        </div>)}
      </div>}
    </aside>
  )
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
  const [view, setView] = useState<'chat' | 'capabilities' | 'activity'>('chat')
  const [definitions, setDefinitions] = useState<AgentDefinitionSummary[]>([])
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const onProjection = useCallback((value: LiveState) => setLive(value), [])
  const isRunning = ['running', 'cancelling'].includes(live.projection.status)

  useEffect(() => {
    const controller = new AbortController()
    setDefinitions([])
    void json<SessionActivitySnapshot>(`/api/sessions/${session.id}/activity`, {
      signal: controller.signal,
    }).then(activity => {
      if (!controller.signal.aborted) setDefinitions(activity.definitions)
    }).catch(error => {
      if (!controller.signal.aborted) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    })
    return () => controller.abort()
  }, [session.id])

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
  const forkWorkspace = workspaces.find(candidate => candidate.id === workspaceId && candidate.mode === 'worktree')
  const stopActivity = async (kind: 'agents' | 'tasks', id: string) => run(async () => {
    await command(`/api/sessions/${session.id}/${kind}/${encodeURIComponent(id)}/stop`)
  })

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
            <button className={view === 'activity' ? 'active' : ''} onClick={() => setView('activity')}>Activity</button>
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
          </> : view === 'capabilities' ? <CapabilityPage /> : <div className="mobile-activity">
            <ActivityInspector
              session={session}
              workspace={workspace}
              projection={live.projection}
              definitions={definitions}
              busy={busy}
              onConfiguration={changeConfiguration}
              onStop={stopActivity}
            />
          </div>}
        </main>

        <ActivityInspector
          session={session}
          workspace={workspace}
          projection={live.projection}
          definitions={definitions}
          busy={busy}
          onConfiguration={changeConfiguration}
          onStop={stopActivity}
        />
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
