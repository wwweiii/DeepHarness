import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 2 Harness capability evidence', () => {
  test('projects generic renderer coverage to every discovered tool', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const tools = manifest.capabilities.filter((capability: any) => capability.kind === 'tool')
    expect(tools.length).toBeGreaterThan(50)
    for (const capability of tools) {
      expect(capability.ui_supported).toBe(true)
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'apps/web/src/features/chat/messages/Thread.tsx',
          evidenceType: 'runtime',
        }),
      ]))
    }
  })

  test('marks only the matrix-backed phase 2 capabilities as passed', async () => {
    const [manifest, evidence] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
    ])
    for (const entry of evidence.capabilities.filter((item: any) => (item.phase ?? 2) === 2)) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      expect(capability).toBeDefined()
      expect(capability.tested).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.ui_supported).toBe(true)
      expect(capability.invocable).toBe(entry.invocable === undefined ? true : entry.invocable)
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'tests/integration/phase-2-stack.test.ts',
          evidenceType: 'runtime',
        }),
      ]))
    }

    const coreTools = evidence.capabilities
      .filter((entry: any) => (entry.phase ?? 2) === 2)
      .filter((entry: any) => entry.scenario)
      .map((entry: any) => manifest.capabilities.find((item: any) => item.id === entry.id))
    expect(coreTools.length).toBeGreaterThanOrEqual(10)
    for (const capability of coreTools) {
      expect(capability.enabled).toBe(true)
      expect(capability.tested || ['C', 'D'].includes(capability.matrix_class)).toBe(true)
    }
  })

  test('records AskUserQuestion as a tested adapter with an explicit ACP expected gap', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const question = manifest.capabilities.find((item: any) => item.id === 'tool.AskUserQuestionTool')
    expect(question.tested).toBe(true)
    expect(question.known_gap).toContain('updatedInput.answers')
    const gap = manifest.known_gaps.find(
      (item: any) => item.id === 'gap.acp.ask-user-question-updated-input',
    )
    expect(gap).toMatchObject({ status: 'expected_failure' })
    expect(gap.evidence.length).toBeGreaterThan(0)
    expect(gap.upstream_strategy).toContain('upstream ACP fix')
  })

  test('records inferred terminal tool state without claiming native raw output', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const gap = manifest.known_gaps.find(
      (item: any) => item.id === 'gap.acp.tool-result-terminal-update',
    )
    expect(gap).toMatchObject({ status: 'expected_failure' })
    expect(gap.summary).toContain('tool_result')
    expect(gap.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'src/services/acp/bridge/forwarding.ts',
        evidenceType: 'source',
      }),
      expect.objectContaining({
        path: 'tests/integration/phase-2-stack.test.ts',
        evidenceType: 'runtime',
      }),
    ]))

    const evidence = await json('config/harness-capability-evidence.json')
    const nativeToolCalls = evidence.capabilities.filter((entry: any) => entry.scenario)
    for (const entry of nativeToolCalls) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      if (entry.id === 'tool.TodoWriteTool') {
        expect(capability.known_gap ?? '').not.toContain('rawOutput')
      } else {
        expect(capability.known_gap).toContain('rawOutput')
      }
    }
  })

  test('passes only the fake Anthropic provider and leaves credentialed profiles untested', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const providers = manifest.capabilities.filter((item: any) => item.kind === 'provider')
    expect(providers).toHaveLength(7)
    for (const provider of providers) {
      expect(provider.ui_supported).toBe(true)
      if (provider.id === 'provider.firstParty') {
        expect(provider.tested).toBe(true)
        expect(provider.last_test_result).toBe('passed')
      } else {
        expect(provider.tested).toBe(false)
        expect(provider.last_test_result).toBe('not_tested')
      }
    }
  })

  test('publishes a gated Phase 2 to Phase 3 capability diff', async () => {
    const diff = await json('artifacts/capabilities/vendor-capability-diff.json')
    expect(diff.status).toBe('compared')
    expect(diff.previous_vendor_commit).toBe(diff.current_vendor_commit)
    expect(diff.changed).toHaveLength(6)
    expect(diff.changed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'acp.loadSession' }),
      expect.objectContaining({ id: 'acp.unstable_resumeSession' }),
      expect.objectContaining({ id: 'acp.unstable_forkSession' }),
    ]))
    expect(diff.regressions).toEqual([])
    expect(diff.gate).toEqual({
      unreviewed_additions: [],
      unapproved_regressions: [],
    })
  })

  test('keeps routine audits from overwriting the published phase diff', async () => {
    const makefile = await readFile(`${root}/Makefile`, 'utf8')
    const auditTarget = makefile.slice(
      makefile.indexOf('audit:'),
      makefile.indexOf('\n\nreview-draft:'),
    )
    expect(auditTarget).toContain(
      '--previous artifacts/capabilities/vendor-capability-manifest.json',
    )
    expect(auditTarget).toContain('--artifacts /tmp/deepharness-capability-audit')
  })
})
