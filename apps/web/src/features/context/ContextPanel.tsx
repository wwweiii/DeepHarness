import type {
  ContextCapabilityRecord,
  ContextUsageRecord,
  SessionContextSnapshot,
  SessionProcessState,
  SessionStatus,
} from '@deepharness/protocol'
import {
  CircleAlert,
  CircleCheck,
  Database,
  Gauge,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { requestId } from '../../lib/requestId.ts'

function displayNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unavailable' : value.toLocaleString()
}

function capabilityLabel(capability: ContextCapabilityRecord): string {
  return capability.name.replace(/Tool$/, '')
}

function stateIcon(state: ContextCapabilityRecord['state']) {
  return state === 'supported' || state === 'kernel_managed'
    ? <CircleCheck size={13} aria-hidden="true" />
    : <CircleAlert size={13} aria-hidden="true" />
}

function UsagePanel({ usage }: { usage: ContextUsageRecord | null }) {
  const percentage = Math.max(0, Math.min(100, usage?.percentage ?? 0))
  return <section className="context-section" data-testid="context-usage">
    <div className="context-section-title"><Gauge size={14} aria-hidden="true" />Context usage</div>
    <div className="context-meter-row">
      <div
        className="context-meter"
        role="progressbar"
        aria-label="Context window usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage?.percentage ?? undefined}
      ><span style={{ width: `${percentage}%` }} /></div>
      <strong>{usage?.percentage === null || usage?.percentage === undefined
        ? 'Unavailable'
        : `${usage.percentage}%`}</strong>
    </div>
    <dl className="context-metrics">
      <div><dt>Window</dt><dd>{displayNumber(usage?.usedTokens)} / {displayNumber(usage?.sizeTokens)}</dd></div>
      <div><dt>Input</dt><dd>{displayNumber(usage?.inputTokens)}</dd></div>
      <div><dt>Output</dt><dd>{displayNumber(usage?.outputTokens)}</dd></div>
      <div><dt>Cache read</dt><dd>{displayNumber(usage?.cacheReadTokens)}</dd></div>
      <div><dt>Cache write</dt><dd>{displayNumber(usage?.cacheWriteTokens)}</dd></div>
      <div><dt>Total</dt><dd>{displayNumber(usage?.totalTokens)}</dd></div>
    </dl>
  </section>
}

export function ContextPanel({
  sessionId,
  status,
  processState,
  revision,
}: {
  sessionId: string
  status: SessionStatus
  processState: SessionProcessState
  revision: string
}) {
  const [snapshot, setSnapshot] = useState<SessionContextSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/sessions/${sessionId}/context`, signal ? { signal } : undefined)
    const body = await response.json().catch(() => ({})) as SessionContextSnapshot & { error?: string }
    if (!response.ok) throw new Error(body.error ?? `Context request failed with status ${response.status}`)
    if (!signal?.aborted) {
      setSnapshot(body)
      setError(null)
    }
  }, [sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(loadError => {
      if (!controller.signal.aborted) {
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      }
    })
    return () => controller.abort()
  }, [load, revision])

  const compact = async () => {
    setCompacting(true)
    setError(null)
    try {
      const response = await fetch(`/api/sessions/${sessionId}/context/compact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': requestId(),
        },
        body: '{}',
      })
      const body = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(body.error ?? `Compact request failed with status ${response.status}`)
      await load()
    } catch (compactError) {
      setError(compactError instanceof Error ? compactError.message : String(compactError))
    } finally {
      setCompacting(false)
    }
  }

  if (!snapshot) {
    return <div className="context-panel-state" role={error ? 'alert' : 'status'}>
      {error ?? 'Loading Context state...'}
    </div>
  }

  const transcript = snapshot.transcript
  const canCompact = status === 'idle' && processState === 'running'
  return <div className="context-panel" data-testid="context-memory-panel">
    {error && <div className="context-error" role="alert">{error}</div>}
    <UsagePanel usage={snapshot.usage} />

    <section className="context-section" data-testid="transcript-context">
      <div className="context-section-title"><Database size={14} aria-hidden="true" />Transcript</div>
      <dl className="context-metrics">
        <div><dt>Records</dt><dd>{displayNumber(transcript?.recordCount)}</dd></div>
        <div><dt>User checkpoints</dt><dd>{displayNumber(transcript?.userCheckpointCount)}</dd></div>
        <div><dt>Compactions</dt><dd>{displayNumber(transcript?.compactCount)}</dd></div>
        <div><dt>Latest boundary</dt><dd><code>{transcript?.latestCompactBoundaryId?.slice(0, 12) ?? 'None'}</code></dd></div>
      </dl>
      <button
        className="context-command"
        disabled={!canCompact || compacting}
        onClick={() => void compact()}
      ><RefreshCw size={14} className={compacting ? 'spinning' : ''} aria-hidden="true" />
        {compacting ? 'Compacting' : 'Compact context'}
      </button>
      <div className="context-checkpoints">
        {snapshot.checkpoints.length === 0 && <span className="context-empty">No compact checkpoints</span>}
        {snapshot.checkpoints.slice(0, 5).map(checkpoint => <div key={checkpoint.id}>
          <strong>{checkpoint.trigger} · {checkpoint.status}</strong>
          <small>{checkpoint.preTokens === null ? checkpoint.source : `${checkpoint.preTokens.toLocaleString()} tokens · ${checkpoint.source}`}</small>
        </div>)}
      </div>
    </section>

    <section className="context-section" data-testid="memory-observations">
      <div className="context-section-title"><LockKeyhole size={14} aria-hidden="true" />Memory</div>
      {snapshot.memories.length === 0 && <span className="context-empty">No Memory observations</span>}
      <div className="memory-observation-list">
        {snapshot.memories.slice(0, 10).map(memory => <div key={memory.toolCallId} className="memory-observation">
          <div><strong>{memory.sourceLabel}</strong><span className="redacted-label">content redacted</span></div>
          <small>{memory.operation} · {memory.status} · {memory.hit === null ? 'hit unknown' : memory.hit ? 'hit' : 'miss'}</small>
          {(memory.itemCount !== null || memory.bytes !== null || memory.errorCode) && <code>
            {memory.errorCode ?? `${memory.itemCount ?? 1} item · ${displayNumber(memory.bytes)} bytes`}
          </code>}
        </div>)}
      </div>
    </section>

    <section className="context-section" data-testid="context-capabilities">
      <div className="context-section-title">Capabilities</div>
      <div className="context-capability-list">
        {snapshot.capabilities.map(capability => <div key={capability.id}>
          <span className={`context-capability-state state-${capability.state}`}>
            {stateIcon(capability.state)}{capability.state.replaceAll('_', ' ')}
          </span>
          <strong>{capabilityLabel(capability)}</strong>
          {capability.reason && <small>{capability.reason}</small>}
        </div>)}
      </div>
    </section>

    <section className="context-section" data-testid="session-operations">
      <div className="context-section-title">Session operations</div>
      <pre>{JSON.stringify(snapshot.operations, null, 2)}</pre>
      <div className="compatibility-state">
        <strong>{String(snapshot.compatibility.status ?? 'unknown').replaceAll('_', ' ')}</strong>
        <small>{String(snapshot.compatibility.previousVendorCommit ?? snapshot.compatibility.currentVendorCommit ?? 'Vendor commit unavailable').slice(0, 12)}</small>
      </div>
    </section>

    <details className="context-lifecycle" data-testid="data-lifecycle-boundaries">
      <summary>Data lifecycle</summary>
      {snapshot.lifecycle.map(boundary => <div key={boundary.dataClass}>
        <strong>{boundary.dataClass.replaceAll('_', ' ')}</strong>
        <span>{boundary.controlPlaneContent.replaceAll('_', ' ')}</span>
        <small>{boundary.deleteBoundary}</small>
      </div>)}
    </details>
  </div>
}
