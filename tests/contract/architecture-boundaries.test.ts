import { describe, expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

async function codeFiles(path: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await codeFiles(child))
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) result.push(child)
  }
  return result
}

describe('architecture baseline', () => {
  test('business code does not import vendor internals', async () => {
    const files = [
      ...await codeFiles(join(root, 'apps')),
      ...await codeFiles(join(root, 'packages')),
    ]
    const forbidden = [
      'vendor/claude-code',
      '/QueryEngine',
      '/query.js',
      '/tools.js',
      '/AppState',
      '/bootstrap/state',
    ]
    for (const path of files) {
      const content = await readFile(path, 'utf8')
      const imports = content
        .split('\n')
        .filter(line => /^\s*(?:import|export).*from\s+['"]/.test(line))
        .join('\n')
      for (const token of forbidden) expect(imports).not.toContain(token)
    }
  })

  test('Compose has health checks and never mounts the Docker socket', async () => {
    const compose = await readFile(join(root, 'compose.yaml'), 'utf8')
    expect(compose).not.toContain('/var/run/docker.sock')
    for (const service of ['postgres:', 'gateway:', 'worker:']) {
      expect(compose).toContain(service)
    }
    expect((compose.match(/healthcheck:/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect((compose.match(/read_only: true/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  test('submodule configuration is HTTPS and commit lock is immutable input', async () => {
    const [modules, lock] = await Promise.all([
      readFile(join(root, '.gitmodules'), 'utf8'),
      readFile(join(root, 'config/vendor-lock.json'), 'utf8').then(JSON.parse),
    ])
    expect(modules).toContain('https://github.com/claude-code-best/claude-code.git')
    expect(modules).not.toContain('git@github.com:')
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/)
  })
})
