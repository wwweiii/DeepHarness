import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 9 full capability matrix closure', () => {
  test('has no unclassified, ownerless, or unexplained untested capability', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    expect(manifest.summary.unclassified).toBe(0)
    expect(manifest.summary.ownerless).toBe(0)
    expect(manifest.summary.unexplained_untested).toBe(0)
    expect(manifest.summary.unexplained_untested_ids).toEqual([])

    for (const capability of manifest.capabilities) {
      expect(capability.owner).toBeTruthy()
      expect(capability.classification_rationale).toBeTruthy()
      expect(capability.source_evidence.length).toBeGreaterThan(0)
      if (capability.enabled && ['A', 'B'].includes(capability.matrix_class)) {
        expect(capability.tested).toBe(true)
        expect(capability.last_test_result).toBe('passed')
      }
      if (capability.matrix_class === 'C') {
        expect(capability.tested).toBe(true)
        expect(['passed', 'expected_failure']).toContain(capability.last_test_result)
        expect(capability.known_gap).toBeTruthy()
        expect(capability.upstream_strategy).toContain('upstream ACP fix')
      }
      if (capability.matrix_class === 'D') {
        expect(capability.conditions.length).toBeGreaterThan(0)
        if (!capability.tested) expect(capability.known_gap).toBeTruthy()
      }
      if (capability.matrix_class === 'E') {
        expect(capability.classification_rationale).toBeTruthy()
      }
    }
  })

  test('keeps credentialed providers explicitly not tested rather than supported', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const credentialed = manifest.capabilities.filter(
      (capability: any) => capability.kind === 'provider' && capability.id !== 'provider.firstParty',
    )
    expect(credentialed.length).toBeGreaterThan(0)
    expect(manifest.summary.untested).toBe(credentialed.length)
    expect(manifest.summary.credential_blocked_untested).toBe(credentialed.length)
    for (const capability of credentialed) {
      expect(capability.matrix_class).toBe('D')
      expect(capability.enabled).toBe(false)
      expect(capability.tested).toBe(false)
      expect(capability.last_test_result).toBe('not_tested')
      expect(capability.known_gap).toContain('Credentialed provider profile')
    }
  })
})
