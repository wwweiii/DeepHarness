import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 3 ACP recovery contract', () => {
  test('keeps the Harness recovery implementation on the ACP boundary', async () => {
    const [client, supervisor, transcript] = await Promise.all([
      readFile(`${root}/apps/worker/src/acp/client.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/supervisor.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/transcript.ts`, 'utf8'),
    ])
    expect(client).toContain("request('session/resume'")
    expect(client).toContain("request('session/load'")
    expect(client).toContain("request('session/fork'")
    expect(client).toContain("request('session/close'")
    expect(supervisor).toContain("recoveryStrategy !== 'resume'")
    expect(supervisor).toContain("status: 'recovery_required'")
    expect(supervisor).toContain("state: 'vendor_managed'")
    expect(supervisor).toContain('acpMethod: null')
    expect(transcript).toContain('TRANSCRIPT_MISSING')
    expect(transcript).toContain('TRANSCRIPT_CORRUPT')
    expect(supervisor).not.toMatch(/from ['"].*vendor\/claude-code/)
  })

  test('publishes runtime evidence for advertised and invoked recovery capabilities', async () => {
    const [manifest, evidence] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
    ])
    const entries = evidence.capabilities.filter((entry: any) => entry.phase === 3)
    expect(entries.map((entry: any) => entry.id).sort()).toEqual([
      'acp.advertised:_meta.claudeCode.forkSession',
      'acp.advertised:loadSession',
      'acp.advertised:sessionCapabilities.resume',
      'acp.loadSession',
      'acp.unstable_forkSession',
      'acp.unstable_resumeSession',
    ])
    for (const entry of entries) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      expect(capability).toBeDefined()
      expect(capability.tested).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          path: 'tests/integration/phase-3-stack.test.ts',
          evidenceType: 'runtime',
        }),
      ]))
    }
  })
})
