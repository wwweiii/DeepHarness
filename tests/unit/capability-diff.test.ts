import { describe, expect, test } from 'bun:test'
import { capabilityDiff } from '../../packages/vendor-capabilities/src/diff.ts'
import type { Capability } from '../../packages/vendor-capabilities/src/types.ts'

function capability(matrixClass: Capability['matrix_class']): Capability {
  return {
    id: 'tool.ConditionalTool',
    kind: 'tool',
    name: 'ConditionalTool',
    matrix_class: matrixClass,
    classification_rationale: 'test',
    compiled: true,
    enabled: true,
    advertised_by_acp: false,
    invocable: true,
    ui_supported: true,
    tested: true,
    conditions: [],
    source_evidence: [],
    known_gap: null,
    last_test_result: 'passed',
  }
}

describe('capability regression approval', () => {
  test('requires an exact id and matrix transition while retaining regression evidence', () => {
    const previous = { vendor_commit: 'a', capabilities: [capability('A')] }
    const current = { vendor_commit: 'a', capabilities: [capability('D')] }
    const blocked = capabilityDiff(previous, current) as any
    expect(blocked.regressions).toHaveLength(1)
    expect(blocked.gate.unapproved_regressions).toEqual(['tool.ConditionalTool'])

    const wrongTransition = capabilityDiff(previous, current, [{
      id: 'tool.ConditionalTool',
      from: 'B',
      to: 'D',
    }]) as any
    expect(wrongTransition.gate.unapproved_regressions).toEqual(['tool.ConditionalTool'])

    const approved = capabilityDiff(previous, current, [{
      id: 'tool.ConditionalTool',
      from: 'A',
      to: 'D',
    }]) as any
    expect(approved.regressions).toHaveLength(1)
    expect(approved.gate.unapproved_regressions).toEqual([])
  })
})
