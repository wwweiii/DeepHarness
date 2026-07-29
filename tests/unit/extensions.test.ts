import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverExtensions,
  setExtensionEnabled,
} from '../../apps/worker/src/extensions.ts'

const temporaryDirectories: string[] = []

async function temporaryWorkspace(): Promise<{ cwd: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'deepharness-extensions-'))
  temporaryDirectories.push(root)
  const cwd = path.join(root, 'workspace')
  const home = path.join(root, 'home')
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(home, { recursive: true })])
  return { cwd, home }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })))
})

describe('phase 5 extension discovery', () => {
  test('projects sources and redacts MCP credentials without hiding ACP blockers', async () => {
    const { cwd, home } = await temporaryWorkspace()
    const priorHome = process.env.HOME
    process.env.HOME = home
    try {
      await mkdir(path.join(cwd, '.claude', 'skills', 'verified-skill'), { recursive: true })
      await writeFile(path.join(cwd, '.claude', 'skills', 'verified-skill', 'SKILL.md'), [
        '---',
        'name: verified-skill',
        'description: Verified phase five Skill',
        '---',
        '',
        'Run the verification.',
      ].join('\n'), 'utf8')
      await writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
        enabledPlugins: { 'verified@local': true },
        hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'true' }] }] },
        env: { SECRET_VALUE: 'must-not-be-projected' },
      }), 'utf8')
      await writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          verified: {
            type: 'http',
            url: 'https://user:pass@example.test/mcp?token=secret',
            headers: { Authorization: 'Bearer secret' },
          },
        },
      }), 'utf8')

      const snapshot = await discoverExtensions(cwd)
      expect(snapshot.extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'skill', name: 'verified-skill', source: 'project', status: 'ready' }),
        expect.objectContaining({ kind: 'plugin', name: 'verified@local', enabled: true }),
        expect.objectContaining({ kind: 'hook', name: 'PreToolUse', status: 'ready' }),
      ]))
      expect(snapshot.mcpServers).toEqual([
        expect.objectContaining({
          name: 'verified',
          endpoint: 'https://example.test/mcp',
          health: 'blocked',
          authStatus: 'configured',
          supportsResources: false,
        }),
      ])
      expect(JSON.stringify({
        extensions: snapshot.extensions,
        servers: snapshot.mcpServers,
      })).not.toMatch(/must-not-be-projected|Bearer secret|user:pass|token=secret/)
      expect(snapshot.acpMcpServers).toEqual([{
        name: 'verified',
        type: 'http',
        url: 'https://user:pass@example.test/mcp?token=secret',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      }])
    } finally {
      if (priorHome === undefined) delete process.env.HOME
      else process.env.HOME = priorHome
    }
  })

  test('normalizes stdio MCP arguments and environment for ACP', async () => {
    const { cwd, home } = await temporaryWorkspace()
    const priorHome = process.env.HOME
    process.env.HOME = home
    try {
      await writeFile(path.join(cwd, '.mcp.json'), JSON.stringify({
        mcpServers: {
          stdio: {
            command: '/usr/bin/example-mcp',
            args: ['--stdio', 42],
            env: { MCP_TOKEN: 'runtime-only', INVALID: 42 },
          },
          invalid: { type: 'websocket', url: 'wss://example.test/mcp' },
          invalidUrl: { type: 'http', url: 'not a URL' },
        },
      }), 'utf8')

      const snapshot = await discoverExtensions(cwd)
      expect(snapshot.acpMcpServers).toEqual([{
        name: 'stdio',
        command: '/usr/bin/example-mcp',
        args: ['--stdio'],
        env: [{ name: 'MCP_TOKEN', value: 'runtime-only' }],
      }])
      expect(snapshot.mcpServers.find(server => server.name === 'invalid')).toMatchObject({
        health: 'error',
        error: 'Invalid MCP configuration',
        blockedReason: 'Unsupported MCP transport: websocket.',
      })
      expect(snapshot.mcpServers.find(server => server.name === 'invalidUrl')).toMatchObject({
        health: 'error',
        error: 'Invalid MCP configuration',
        blockedReason: 'Remote MCP server requires a valid URL.',
      })
      expect(snapshot.mcpServers.find(server => server.name === 'stdio')).toMatchObject({
        authStatus: 'configured',
      })
    } finally {
      if (priorHome === undefined) delete process.env.HOME
      else process.env.HOME = priorHome
    }
  })

  test('isolates invalid settings and atomically controls local Plugin and Hook state', async () => {
    const { cwd, home } = await temporaryWorkspace()
    const priorHome = process.env.HOME
    process.env.HOME = home
    try {
      await mkdir(path.join(cwd, '.claude'), { recursive: true })
      await writeFile(path.join(cwd, '.claude', 'settings.json'), '{invalid', 'utf8')
      const invalid = await discoverExtensions(cwd)
      expect(invalid.sourceErrors).toHaveLength(1)
      expect(invalid.extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'setting', status: 'error' }),
        expect.objectContaining({ name: 'SkillTool', status: 'ready' }),
      ]))

      await setExtensionEnabled({ cwd, kind: 'plugin', name: 'verified@local', enabled: true })
      await setExtensionEnabled({ cwd, kind: 'hook', name: 'all', enabled: false })
      const local = JSON.parse(await readFile(
        path.join(cwd, '.claude', 'settings.local.json'),
        'utf8',
      ))
      expect(local).toMatchObject({
        enabledPlugins: { 'verified@local': true },
        disableAllHooks: true,
      })
    } finally {
      if (priorHome === undefined) delete process.env.HOME
      else process.env.HOME = priorHome
    }
  })
})
