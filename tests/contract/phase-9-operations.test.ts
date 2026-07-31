import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

async function text(path: string): Promise<string> {
  return readFile(`${root}/${path}`, 'utf8')
}

describe('phase 9 operations and release gate', () => {
  test('defines durable auth and backup metadata without weakening the ACP boundary', async () => {
    const [migration, auth, server, compose] = await Promise.all([
      text('packages/database/migrations/0009_phase_9.sql'),
      text('apps/gateway/src/auth.ts'),
      text('apps/gateway/src/server.ts'),
      text('compose.yaml'),
    ])
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS users')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS auth_sessions')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS backup_runs')
    expect(auth).toContain('FixedWindowRateLimiter')
    expect(auth).toContain('hasCsrfToken')
    expect(server).toContain("/api/auth/login")
    expect(server).toContain("/metrics")
    expect(compose).not.toContain('/var/run/docker.sock')
  })

  test('publishes owner-complete matrix truth and operator recovery entrypoints', async () => {
    const manifest = JSON.parse(await text('artifacts/capabilities/vendor-capability-manifest.json')) as {
      summary: {
        unclassified: number
        ownerless: number
        unexplained_untested: number
        untested: number
        credential_blocked_untested: number
      }
      capabilities: Array<{
        owner?: string
        matrix_class: string
        enabled: boolean
        tested: boolean
        last_test_result: string
        source_evidence: unknown[]
        known_gap?: string | null
        upstream_strategy?: string | null
      }>
    }
    expect(manifest.summary.unclassified).toBe(0)
    expect(manifest.summary.ownerless).toBe(0)
    expect(manifest.summary.unexplained_untested).toBe(0)
    expect(manifest.summary.untested).toBe(manifest.summary.credential_blocked_untested)
    for (const capability of manifest.capabilities) {
      expect(capability.owner).toBeTruthy()
      expect(['A', 'B', 'C', 'D', 'E']).toContain(capability.matrix_class)
      expect(capability.source_evidence.length).toBeGreaterThan(0)
      if (capability.enabled && ['A', 'B'].includes(capability.matrix_class)) {
        expect(capability.tested).toBe(true)
        expect(capability.last_test_result).toBe('passed')
      }
      if (capability.matrix_class === 'C') {
        expect(capability.tested).toBe(true)
        expect(capability.known_gap).toBeTruthy()
        expect(capability.upstream_strategy).toBeTruthy()
      }
    }
    for (const file of [
      'docs/operations/install.md',
      'docs/operations/runbook.md',
      'docs/operations/troubleshooting.md',
      'docs/operations/capability-matrix.md',
      'docs/operations/vendor-upgrades.md',
      'docs/verification/phase-9.md',
      'scripts/backup.sh',
      'scripts/restore-check.sh',
      'scripts/vendor-upgrade-check.sh',
    ]) expect((await text(file)).length).toBeGreaterThan(100)
  })
})
