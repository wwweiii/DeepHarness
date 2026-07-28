import type { CapabilityView, JsonValue } from '@deepharness/protocol'
import { AlertTriangle, Check, Search, ServerCog, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

function dimension(value: JsonValue | undefined) {
  if (value === true) return <span className="dimension dimension-yes"><Check size={13} /> Yes</span>
  if (value === false) return <span className="dimension dimension-no"><X size={13} /> No</span>
  return <span className="dimension dimension-na">N/A</span>
}

export function CapabilityPage() {
  const [view, setView] = useState<CapabilityView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [matrixClass, setMatrixClass] = useState('all')

  useEffect(() => {
    void fetch('/api/capabilities')
      .then(async response => {
        if (!response.ok) throw new Error(`Capability request failed: ${response.status}`)
        setView(await response.json() as CapabilityView)
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  const capabilities = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return (view?.capabilities ?? []).filter(capability => {
      if (kind !== 'all' && capability.kind !== kind) return false
      if (matrixClass !== 'all' && capability.matrix_class !== matrixClass) return false
      return !normalized || `${capability.id} ${capability.name}`.toLowerCase().includes(normalized)
    })
  }, [kind, matrixClass, query, view?.capabilities])

  if (error) return <div className="capability-state capability-error">{error}</div>
  if (!view) return <div className="capability-state">Loading capabilities...</div>
  const kinds = [...new Set(view.capabilities.map(capability => String(capability.kind)))].sort()

  return (
    <section className="capability-page">
      <header className="capability-header">
        <div>
          <h1>Capabilities</h1>
          <p><code>{view.vendorCommit.slice(0, 12)}</code> · {view.capabilities.length} entries</p>
        </div>
        <div className="capability-summary">
          <span><strong>{String(view.summary.unclassified ?? 0)}</strong> unclassified</span>
          <span><strong>{view.knownGaps.length}</strong> known gaps</span>
        </div>
      </header>

      <div className="provider-strip">
        {view.providers.map(provider => (
          <article key={provider.id} className={provider.active ? 'provider active' : 'provider'}>
            <ServerCog size={16} aria-hidden="true" />
            <span><strong>{provider.name}</strong><small>{provider.credentialStatus}</small></span>
            <span className={`test-state test-${provider.automatedTest}`}>{provider.automatedTest.replace('_', ' ')}</span>
          </article>
        ))}
      </div>

      <div className="capability-filters">
        <label className="capability-search"><Search size={15} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="Search capabilities" placeholder="Search" /></label>
        <select value={kind} onChange={event => setKind(event.target.value)} aria-label="Capability kind">
          <option value="all">All kinds</option>
          {kinds.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <div className="segmented-control" aria-label="Matrix class">
          {['all', 'A', 'B', 'C', 'D', 'E'].map(value => (
            <button key={value} className={matrixClass === value ? 'active' : ''} onClick={() => setMatrixClass(value)}>{value === 'all' ? 'All' : value}</button>
          ))}
        </div>
      </div>

      <div className="capability-table-wrap">
        <table className="capability-table">
          <thead><tr><th>Capability</th><th>Class</th><th>Compiled</th><th>Enabled</th><th>ACP</th><th>Invocable</th><th>UI</th><th>Tested</th></tr></thead>
          <tbody>
            {capabilities.map(capability => (
              <tr key={String(capability.id)}>
                <td>
                  <strong>{String(capability.name)}</strong>
                  <code>{String(capability.id)}</code>
                  {(capability.known_gap || capability.last_test_result === 'expected_failure') && (
                    <details className="capability-evidence">
                      <summary><AlertTriangle size={13} /> Evidence</summary>
                      {capability.known_gap && <p>{String(capability.known_gap)}</p>}
                      <pre>{JSON.stringify(capability.source_evidence ?? [], null, 2)}</pre>
                    </details>
                  )}
                </td>
                <td><span className={`matrix matrix-${String(capability.matrix_class)}`}>{String(capability.matrix_class)}</span></td>
                <td>{dimension(capability.compiled)}</td>
                <td>{dimension(capability.enabled)}</td>
                <td>{dimension(capability.advertised_by_acp)}</td>
                <td>{dimension(capability.invocable)}</td>
                <td>{dimension(capability.ui_supported)}</td>
                <td>{dimension(capability.tested)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
