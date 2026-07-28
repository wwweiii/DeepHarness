import { describe, expect, test } from 'bun:test'
import { readFile, stat } from 'node:fs/promises'

const root = process.cwd()

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('vendor capability manifest gate', () => {
  test('is traceable to the locked vendor commit', async () => {
    const [lock, manifest, staticReport, dynamicReport] = await Promise.all([
      json('config/vendor-lock.json'),
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('artifacts/capabilities/vendor-static-audit-report.json'),
      json('artifacts/capabilities/vendor-acp-probe-report.json'),
    ])
    expect(manifest.vendor_commit).toBe(lock.commit)
    expect(staticReport.vendor_commit).toBe(lock.commit)
    expect(dynamicReport.vendor_commit).toBe(lock.commit)
    expect(manifest.probe_environment.static_probe).toBe('static-source-audit')
    expect(manifest.probe_environment.dynamic_probe).toBe('ccb-bun-acp-stdio')
  })

  test('has complete reviewed classifications and six-dimensional state', async () => {
    const [manifest, review] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/vendor-capability-review.json'),
    ])
    expect(manifest.summary.unclassified).toBe(0)
    expect(manifest.capabilities.length).toBeGreaterThan(100)
    expect(new Set(manifest.capabilities.map((item: any) => item.id)).size).toBe(
      manifest.capabilities.length,
    )
    for (const capability of manifest.capabilities) {
      expect(['A', 'B', 'C', 'D', 'E']).toContain(capability.matrix_class)
      expect(typeof capability.compiled).toBe('boolean')
      expect(typeof capability.enabled).toBe('boolean')
      expect(typeof capability.advertised_by_acp).toBe('boolean')
      expect(
        capability.invocable === null || typeof capability.invocable === 'boolean',
      ).toBe(true)
      expect(typeof capability.ui_supported).toBe('boolean')
      expect(typeof capability.tested).toBe('boolean')
      expect(capability.source_evidence.length).toBeGreaterThan(0)
    }
    expect(Object.keys(review.entries).sort()).toEqual(
      manifest.capabilities.map((item: any) => item.id).sort(),
    )
  })

  test('keeps every static evidence path traceable to the vendor source tree', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const paths = new Set<string>()
    for (const capability of manifest.capabilities) {
      for (const evidence of capability.source_evidence) {
        if (evidence.evidenceType === 'source') paths.add(evidence.path)
      }
    }
    for (const path of paths) {
      expect((await stat(`${root}/vendor/claude-code/${path}`)).isFile() ||
        (await stat(`${root}/vendor/claude-code/${path}`)).isDirectory()).toBe(true)
    }
  })

  test('covers every mandatory capability domain', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    for (const key of [
      'build_features',
      'runtime_flags',
      'tools',
      'commands',
      'agents',
      'providers',
      'platform_integrations',
      'acp_capabilities',
    ]) {
      expect(Array.isArray(manifest[key])).toBe(true)
      expect(manifest[key].length).toBeGreaterThan(0)
    }
  })

  test('projects successful phase-1 ACP runtime checks', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    for (const id of [
      'acp.initialize',
      'acp.newSession',
      'acp.prompt',
      'acp.cancel',
      'acp.sessionUpdate.text',
    ]) {
      const capability = manifest.capabilities.find((item: any) => item.id === id)
      expect(capability.invocable).toBe(true)
      expect(capability.tested).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.source_evidence.some((item: any) => item.evidenceType === 'runtime')).toBe(true)
    }
    for (const id of ['acp.prompt', 'acp.cancel', 'acp.sessionUpdate.text']) {
      expect(manifest.capabilities.find((item: any) => item.id === id).ui_supported).toBe(true)
    }
  })
})
