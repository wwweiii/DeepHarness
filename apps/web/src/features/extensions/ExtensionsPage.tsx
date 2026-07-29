import type {
  AvailableCommand,
  ExtensionEntry,
  McpServerStatus,
  SessionExtensionSnapshot,
} from '@deepharness/protocol'
import {
  Blocks,
  Check,
  CircleAlert,
  Plug,
  RefreshCw,
  Search,
  TerminalSquare,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { requestId } from '../../lib/requestId.ts'

type ExtensionTab = 'commands' | 'skills' | 'plugins' | 'hooks' | 'mcp'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const value = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? `Request failed with status ${response.status}`)
  return value
}

function mutable(path: string, method: 'POST' | 'PATCH', body: Record<string, unknown> = {}) {
  return json(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': requestId(),
    },
    body: JSON.stringify(body),
  })
}

function sourceLabel(entry: ExtensionEntry): string {
  return `${entry.source}${entry.path ? ` · ${entry.path}` : ''}`
}

function CommandRows({ commands }: { commands: AvailableCommand[] }) {
  return <><div className="extension-contract-gap" role="status">
    <CircleAlert size={14} />
    <span>Catalog changes are applied from ACP updates. The locked Agent requires a session restart after command or Skill files change.</span>
  </div><div className="extension-rows" data-testid="command-catalog">
    {commands.map(command => <div
      className="extension-row command-row"
      key={`${command.commandType}:${command.name}`}
      data-callable={command.callable}
    >
      <TerminalSquare size={16} aria-hidden="true" />
      <div className="extension-main">
        <strong>/{command.name}</strong>
        <span>{command.description}</span>
        <small>{command.commandType} · {command.source}{command.inputHint ? ` · ${command.inputHint}` : ''}</small>
        {command.blockedReason && <p className="extension-blocked"><CircleAlert size={12} />{command.blockedReason}</p>}
      </div>
      <span className={`extension-status status-${command.callable ? 'ready' : 'blocked'}`}>
        {command.callable ? 'callable' : 'ACP blocked'}
      </span>
    </div>)}
  </div></>
}

function ExtensionRows({ entries }: { entries: ExtensionEntry[] }) {
  return <div className="extension-rows">
    {entries.map(entry => <div className="extension-row" key={entry.id}>
      <Blocks size={16} aria-hidden="true" />
      <div className="extension-main">
        <strong>{entry.name}</strong>
        <span>{entry.condition ?? 'No activation condition reported'}</span>
        <small>{sourceLabel(entry)}</small>
        {entry.error && <p className="extension-blocked"><CircleAlert size={12} />{entry.error}</p>}
      </div>
      <span className={`extension-status status-${entry.status}`}>{entry.status}</span>
    </div>)}
  </div>
}

function McpRows({ servers, sessionId }: { servers: McpServerStatus[]; sessionId: string }) {
  const [resources, setResources] = useState<Record<string, string>>({})
  return <div className="extension-rows" data-testid="mcp-registry">
    {servers.map(server => <div className="extension-row mcp-row" key={`${server.source}:${server.name}`}>
      <Plug size={16} aria-hidden="true" />
      <div className="extension-main">
        <strong>{server.name}</strong>
        <span>{server.transport} · {server.endpoint ?? 'endpoint unavailable'}</span>
        <small>{server.source} · auth {server.authStatus} · resources {server.resources.length}</small>
        {server.blockedReason && <p className="extension-blocked"><CircleAlert size={12} />{server.blockedReason}</p>}
        {resources[server.name] && <pre>{resources[server.name]}</pre>}
      </div>
      <div className="mcp-actions">
        <span className={`extension-status status-${server.health}`}>{server.health}</span>
        <button
          className="icon-button compact-button"
          title={server.supportsResources ? 'Browse resources' : server.blockedReason ?? 'Resources unavailable'}
          aria-label={`Browse ${server.name} resources`}
          onClick={() => void json<{
            available: boolean
            resources: unknown[]
            blockedReason: string | null
          }>(`/api/sessions/${encodeURIComponent(sessionId)}/mcp/${encodeURIComponent(server.name)}/resources`)
            .then(value => setResources(current => ({
              ...current,
              [server.name]: value.available
                ? JSON.stringify(value.resources, null, 2)
                : value.blockedReason ?? 'Resources unavailable',
            })))}
        ><Search size={13} /></button>
        <button
          className="icon-button compact-button"
          title={server.blockedReason ?? 'Authenticate MCP server'}
          aria-label={`Authenticate ${server.name}`}
          disabled={!server.supportsTools}
        ><Check size={13} /></button>
      </div>
    </div>)}
  </div>
}

export function ExtensionsPage({ sessionId, mutableState }: {
  sessionId: string
  mutableState: boolean
}) {
  const [snapshot, setSnapshot] = useState<SessionExtensionSnapshot | null>(null)
  const [tab, setTab] = useState<ExtensionTab>('commands')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    setSnapshot(await json<SessionExtensionSnapshot>(
      `/api/sessions/${encodeURIComponent(sessionId)}/extensions`,
    ))
  }, [sessionId])

  useEffect(() => {
    void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
    const reload = () => void load().catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
    source.addEventListener('commands.updated', reload)
    source.addEventListener('extensions.updated', reload)
    source.addEventListener('extension.configuration_changed', reload)
    return () => source.close()
  }, [load, sessionId])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const filteredCommands = useMemo(() => (snapshot?.commands ?? []).filter(command =>
    `${command.name} ${command.description} ${command.commandType}`.toLowerCase().includes(query.toLowerCase())),
  [query, snapshot?.commands])
  const entries = snapshot?.extensions ?? []
  const filteredEntries = (kinds: ExtensionEntry['kind'][]) => entries.filter(entry =>
    kinds.includes(entry.kind)
      && `${entry.name} ${entry.source} ${entry.condition ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const hooksEnabled = !entries.some(entry => entry.kind === 'hook' && !entry.enabled)

  if (!snapshot) return <div className="capability-state">{error ?? 'Loading extensions...'}</div>
  return <section className="extension-page">
    <header className="extension-header">
      <div><h1>Extensions</h1><p>Runtime sources, activation state, errors, and ACP reachability</p></div>
      <div className="extension-header-actions">
        <span>{snapshot.commands.filter(command => command.callable).length} commands</span>
        <span>{entries.filter(entry => entry.status === 'error').length} errors</span>
        <button
          className="icon-button"
          title="Refresh extension state"
          disabled={busy || !mutableState}
          onClick={() => void run(() => mutable(
            `/api/sessions/${encodeURIComponent(sessionId)}/extensions/refresh`,
            'POST',
          ))}
        ><RefreshCw size={15} /></button>
      </div>
    </header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {snapshot.sourceErrors.length > 0 && <div className="extension-source-errors" role="status">
      <CircleAlert size={15} />
      <span>{snapshot.sourceErrors.join(' · ')}</span>
    </div>}
    <div className="extension-toolbar">
      <div className="capability-search"><Search size={14} /><input
        aria-label="Filter extensions"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Filter"
      /></div>
      <div className="extension-tabs" role="tablist">
        {(['commands', 'skills', 'plugins', 'hooks', 'mcp'] as const).map(value => <button
          key={value}
          role="tab"
          aria-selected={tab === value}
          className={tab === value ? 'active' : ''}
          onClick={() => setTab(value)}
        >{value}</button>)}
      </div>
    </div>
    {tab === 'commands' && <CommandRows commands={filteredCommands} />}
    {tab === 'skills' && <ExtensionRows entries={filteredEntries(['skill', 'extra_tool'])} />}
    {tab === 'plugins' && <div className="extension-rows" data-testid="plugin-registry">
      {filteredEntries(['plugin']).map(entry => <div className="extension-row" key={entry.id}>
        <Blocks size={16} />
        <div className="extension-main"><strong>{entry.name}</strong><span>{entry.condition}</span><small>{sourceLabel(entry)}</small></div>
        <label className="extension-toggle"><input
          type="checkbox"
          checked={entry.enabled}
          disabled={busy || !mutableState}
          onChange={event => void run(() => mutable(
            `/api/sessions/${encodeURIComponent(sessionId)}/extensions/plugin/${encodeURIComponent(entry.name)}`,
            'PATCH',
            { enabled: event.target.checked },
          ))}
        /><span>{entry.enabled ? 'enabled' : 'disabled'}</span></label>
      </div>)}
    </div>}
    {tab === 'hooks' && <>
      <div className="extension-control-line">
        <span>All workspace Hooks</span>
        <label className="extension-toggle"><input
          type="checkbox"
          checked={hooksEnabled}
          disabled={busy || !mutableState}
          onChange={event => void run(() => mutable(
            `/api/sessions/${encodeURIComponent(sessionId)}/extensions/hook/all`,
            'PATCH',
            { enabled: event.target.checked },
          ))}
        /><span>{hooksEnabled ? 'enabled' : 'disabled'}</span></label>
      </div>
      <ExtensionRows entries={filteredEntries(['hook', 'setting'])} />
    </>}
    {tab === 'mcp' && <McpRows sessionId={sessionId} servers={snapshot.mcpServers.filter(server =>
      `${server.name} ${server.transport} ${server.source}`.toLowerCase().includes(query.toLowerCase()))} />}
    {snapshot.audits.length > 0 && <details className="extension-audit">
      <summary>Configuration audit ({snapshot.audits.length})</summary>
      {snapshot.audits.map(audit => <div key={audit.id}>
        <code>{audit.kind}:{audit.name}</code><span>{audit.action} · restart required</span>
      </div>)}
    </details>}
  </section>
}
