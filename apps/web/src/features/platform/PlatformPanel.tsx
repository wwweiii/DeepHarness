import type {
  ArtifactRecord,
  LspDiagnosticRecord,
  LspLocationRecord,
  PlatformIntegrationRecord,
  WebSourceRecord,
} from '@deepharness/protocol'
import { AlertTriangle, Download, ExternalLink, FileCode2, Globe2, Image, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

interface PlatformPanelProps {
  sessionId: string
}

async function load<T>(path: string): Promise<T> {
  const response = await fetch(path)
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}`)
  return body
}

function ArtifactList({ sessionId }: PlatformPanelProps) {
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void load<{ artifacts: ArtifactRecord[] }>(`/api/sessions/${sessionId}/artifacts`)
      .then(value => active && setArtifacts(value.artifacts))
      .catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => { active = false }
  }, [sessionId])
  return <section className="platform-section" data-testid="artifact-panel">
    <div className="platform-section-title"><Image size={15} />Artifacts</div>
    {error && <div className="platform-error" role="alert">{error}</div>}
    {artifacts.length === 0 && !error && <p className="platform-empty">No artifacts observed in this session.</p>}
    <div className="artifact-list">
      {artifacts.map(artifact => <article key={artifact.id} className={`artifact-row artifact-${artifact.status}`}>
        <div className="artifact-main"><strong>{artifact.name}</strong><small>{artifact.mimeType} · {artifact.sizeBytes.toLocaleString()} bytes</small></div>
        {artifact.status === 'ready' && artifact.contentAvailable ? <div className="artifact-actions">
          {artifact.previewable && <a href={`/api/sessions/${sessionId}/artifacts/${artifact.id}/preview`} target="_blank" rel="noreferrer" title="Preview artifact"><ExternalLink size={14} /></a>}
          {artifact.downloadable && <a href={`/api/sessions/${sessionId}/artifacts/${artifact.id}/download`} title="Download artifact"><Download size={14} /></a>}
        </div> : <span className="artifact-rejection"><AlertTriangle size={13} />{artifact.rejectionReason ?? 'unavailable'}</span>}
      </article>)}
    </div>
  </section>
}

function LspPanel({ sessionId }: PlatformPanelProps) {
  const [diagnostics, setDiagnostics] = useState<LspDiagnosticRecord[]>([])
  const [locations, setLocations] = useState<LspLocationRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void Promise.all([
      load<{ diagnostics: LspDiagnosticRecord[] }>(`/api/sessions/${sessionId}/lsp/diagnostics`),
      load<{ locations: LspLocationRecord[] }>(`/api/sessions/${sessionId}/lsp/locations`),
    ]).then(([diagnosticResult, locationResult]) => {
      if (!active) return
      setDiagnostics(diagnosticResult.diagnostics)
      setLocations(locationResult.locations)
    }).catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => { active = false }
  }, [sessionId])
  return <section className="platform-section" data-testid="lsp-panel">
    <div className="platform-section-title"><FileCode2 size={15} />LSP diagnostics and locations</div>
    {error && <div className="platform-error" role="alert">{error}</div>}
    {diagnostics.length === 0 && locations.length === 0 && !error && <p className="platform-empty">No LSP observations in this session.</p>}
    <div className="diagnostic-list">{diagnostics.map(item => <div key={item.id} className={`diagnostic-row severity-${item.severity}`}>
      <span>{item.severity}</span><strong>{item.message}</strong><small>{item.path ?? item.uri}{item.line === null ? '' : `:${item.line + 1}:${(item.column ?? 0) + 1}`}</small>
    </div>)}</div>
    <div className="location-list">{locations.map(item => <div key={item.id} className="location-row">
      <span>{item.operation}</span><code>{item.path ?? item.uri}</code><small>{item.line === null ? 'position unavailable' : `line ${item.line + 1}`}</small>
    </div>)}</div>
  </section>
}

function WebPanel({ sessionId }: PlatformPanelProps) {
  const [sources, setSources] = useState<WebSourceRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void load<{ sources: WebSourceRecord[] }>(`/api/sessions/${sessionId}/web/sources`)
      .then(value => active && setSources(value.sources))
      .catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => { active = false }
  }, [sessionId])
  return <section className="platform-section" data-testid="web-panel">
    <div className="platform-section-title"><Globe2 size={15} />Web sources</div>
    {error && <div className="platform-error" role="alert">{error}</div>}
    {sources.length === 0 && !error && <p className="platform-empty">No WebFetch or WebSearch sources observed.</p>}
    <div className="source-list">{sources.map(source => <a key={source.id} className="source-row" href={source.url} target="_blank" rel="noreferrer">
      <strong>{source.title}</strong><small>{source.url}</small>{source.snippet && <span>{source.snippet}</span>}
    </a>)}</div>
  </section>
}

function PlatformStatus({ sessionId }: PlatformPanelProps) {
  const [integrations, setIntegrations] = useState<PlatformIntegrationRecord[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void load<{ integrations: PlatformIntegrationRecord[] }>(`/api/sessions/${sessionId}/platform`)
      .then(value => active && setIntegrations(value.integrations))
      .catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    return () => { active = false }
  }, [sessionId])
  return <section className="platform-section" data-testid="platform-status-panel">
    <div className="platform-section-title"><ShieldCheck size={15} />Platform profiles</div>
    {error && <div className="platform-error" role="alert">{error}</div>}
    {integrations.length === 0 && !error && <p className="platform-empty">Platform status is not available yet.</p>}
    <div className="integration-list">{integrations.map(item => <div key={item.id} className="integration-row">
      <div><strong>{item.kind}</strong><small>{item.profile}</small></div><span className={`integration-status status-${item.status}`}>{item.status}</span>
      {item.conditions.length > 0 && <code>{item.conditions.join(' · ')}</code>}
    </div>)}</div>
  </section>
}

export function PlatformPanel({ sessionId }: PlatformPanelProps) {
  return <div className="platform-page">
    <header className="platform-header"><div><h1>Artifacts and platform</h1><p>Outputs, code intelligence, web provenance, and optional runtime profiles.</p></div></header>
    <ArtifactList sessionId={sessionId} />
    <LspPanel sessionId={sessionId} />
    <WebPanel sessionId={sessionId} />
    <PlatformStatus sessionId={sessionId} />
  </div>
}
