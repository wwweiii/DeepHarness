import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { HARNESS_EVENT_TYPES } from '@deepharness/protocol'

const root = process.cwd()
const phaseSixIds = [
  'acp.listSessions',
  'acp.loadSession',
  'acp.unstable_forkSession',
  'acp.unstable_resumeSession',
  'command.local.compact',
  'feature.EXTRACT_MEMORIES',
  'feature.LODESTONE',
  'feature.PROMPT_CACHE_BREAK_DETECTION',
  'feature.TOKEN_BUDGET',
  'tool.LocalMemoryRecallTool',
  'tool.VaultHttpFetchTool',
]
const phaseSixChangedIds = [
  'acp.listSessions',
  'command.local.compact',
  'feature.EXTRACT_MEMORIES',
  'feature.LODESTONE',
  'feature.PROMPT_CACHE_BREAK_DETECTION',
  'feature.TOKEN_BUDGET',
  'tool.LocalMemoryRecallTool',
  'tool.VaultHttpFetchTool',
]

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 6 Memory, Context, and advanced session contract', () => {
  test('publishes evidence-backed phase 6 capability transitions', async () => {
    const [manifest, evidence, diff] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
      json('artifacts/capabilities/vendor-capability-diff.json'),
    ])
    const entries = evidence.capabilities.filter((entry: any) => entry.phase === 6)
    expect(entries.map((entry: any) => entry.id).sort()).toEqual(phaseSixIds)
    for (const entry of entries) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      expect(capability).toBeDefined()
      expect(capability.tested).toBe(true)
      expect(capability.ui_supported).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('phase-6'),
          evidenceType: 'runtime',
        }),
      ]))
    }
    expect(manifest.capabilities.find((item: any) => item.id === 'command.local.compact'))
      .toMatchObject({ matrix_class: 'B', invocable: true, tested: true })
    expect(manifest.capabilities.find((item: any) => item.id === 'feature.LODESTONE'))
      .toMatchObject({ matrix_class: 'B' })
    expect(manifest.capabilities.find((item: any) => item.id === 'tool.VaultHttpFetchTool'))
      .toMatchObject({ matrix_class: 'D' })
    expect(diff.changed.map((entry: any) => entry.id).sort()).toEqual(phaseSixChangedIds)
    expect(diff.regressions).toEqual([
      expect.objectContaining({ id: 'tool.VaultHttpFetchTool' }),
    ])
    expect(diff.gate).toEqual({ unreviewed_additions: [], unapproved_regressions: [] })
  })

  test('keeps unavailable Context surfaces as reproducible expected failures', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const gaps = new Map(manifest.known_gaps.map((gap: any) => [gap.id, gap]))
    for (const id of [
      'gap.acp.structured-context-inspection',
      'gap.acp.rewind-checkpoint',
      'gap.acp.structured-compact-event',
      'gap.acp.memory-housekeeping-status',
    ]) {
      const gap = gaps.get(id) as Record<string, any> | undefined
      expect(gap).toMatchObject({ status: 'expected_failure' })
      expect(gap?.evidence.length).toBeGreaterThan(0)
      expect(gap?.upstream_strategy).toBeTruthy()
    }
    expect(manifest.capabilities.find((item: any) => item.id === 'tool.CtxInspectTool'))
      .toMatchObject({ matrix_class: 'C', enabled: false, tested: false })
    expect(manifest.capabilities.find((item: any) => item.id === 'feature.CONTEXT_COLLAPSE'))
      .toMatchObject({ matrix_class: 'C', compiled: false, enabled: false })
    expect(manifest.capabilities.find((item: any) => item.id === 'feature.HISTORY_SNIP'))
      .toMatchObject({ matrix_class: 'C', compiled: false, enabled: false })
    expect(manifest.capabilities.find((item: any) => item.id === 'feature.TEAMMEM'))
      .toMatchObject({ matrix_class: 'C', compiled: false, enabled: false })
    expect(manifest.capabilities.find((item: any) => item.id === 'command.local.rewind'))
      .toMatchObject({ matrix_class: 'C', enabled: true, tested: false })
  })

  test('defines durable redacted projections, UI, and lifecycle boundaries', async () => {
    expect(HARNESS_EVENT_TYPES).toEqual(expect.arrayContaining([
      'context.usage_updated',
      'context.compacted',
      'memory.observed',
    ]))
    const [
      database,
      migration,
      memory,
      supervisor,
      contextPanel,
      upstream,
      lifecycle,
    ] = await Promise.all([
      readFile(`${root}/packages/database/src/index.ts`, 'utf8'),
      readFile(`${root}/packages/database/migrations/0006_phase_6.sql`, 'utf8'),
      readFile(`${root}/apps/worker/src/memory.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/supervisor.ts`, 'utf8'),
      readFile(`${root}/apps/web/src/features/context/ContextPanel.tsx`, 'utf8'),
      readFile(`${root}/docs/upstream/phase-6-acp-context-gaps.md`, 'utf8'),
      readFile(`${root}/docs/operations/data-lifecycle.md`, 'utf8'),
    ])
    expect(database).toContain("version: '0006_phase_6'")
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS memory_observations')
    expect(migration).toContain('CHECK (content_redacted = true)')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS context_checkpoints')
    expect(memory).toContain('contentRedacted: true')
    expect(memory).not.toMatch(/import .*vendor\/claude-code/)
    expect(supervisor).toContain("type === 'usage_update'")
    expect(supervisor).toContain("source: 'vendor_transcript_metadata'")
    expect(supervisor).not.toMatch(/from ['"].*vendor\/claude-code/)
    expect(contextPanel).toContain('data-testid="context-memory-panel"')
    expect(contextPanel).toContain('content redacted')
    expect(contextPanel).toContain('Compact context')
    expect(upstream).toContain('supportsNonInteractive=false')
    expect(upstream).toContain('Compacting completed.')
    for (const dataClass of ['Memory', 'transcript', 'artifact', 'database event']) {
      expect(lifecycle).toContain(dataClass)
    }
  })
})
