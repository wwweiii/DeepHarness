import { describe, expect, test } from 'bun:test'
import { gateManifest } from '../../packages/vendor-capabilities/src/cli.ts'

function capability(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tool.MatrixTool',
    owner: 'worker-supervisor',
    matrix_class: 'A',
    classification_rationale: 'Native ACP tool.',
    enabled: true,
    tested: true,
    last_test_result: 'passed',
    conditions: [],
    source_evidence: [{ path: 'runtime', line: 1, detail: 'contract', evidenceType: 'runtime' }],
    known_gap: null,
    upstream_strategy: null,
    ...overrides,
  }
}

function manifest(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    capabilities: [entry],
    summary: { unclassified: 0, ownerless: 0, unexplained_untested: 0 },
  }
}

describe('phase 9 capability release gate', () => {
  test('rejects an enabled A/B capability without a passed contract even when invocability is unknown', () => {
    expect(() => gateManifest(manifest(capability({ tested: false, last_test_result: 'not_tested' })), null))
      .toThrow('enabled_contract_not_passed:tool.MatrixTool')
  })

  test('requires C gap evidence and an upstream strategy', () => {
    expect(() => gateManifest(manifest(capability({
      matrix_class: 'C',
      tested: true,
      last_test_result: 'expected_failure',
      known_gap: null,
      upstream_strategy: null,
    })), null)).toThrow('c_capability_missing_gap:tool.MatrixTool')
  })

  test('accepts an explicit D base-profile degradation and a closed diff', () => {
    expect(() => gateManifest(manifest(capability({
      matrix_class: 'D',
      enabled: false,
      tested: false,
      last_test_result: 'not_tested',
      conditions: ['profile:optional'],
      known_gap: 'Optional profile is not enabled.',
    })), {
      gate: { unreviewed_additions: [], unapproved_regressions: [] },
    })).not.toThrow()
  })
})
