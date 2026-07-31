import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { HARNESS_EVENT_TYPES } from '@deepharness/protocol'

const root = process.cwd()
const phaseFiveIds = [
  'command.prompt.statusline',
  'integration.hooks',
  'integration.plugins',
  'integration.skills',
  'tool.ExecuteExtraTool',
  'tool.SearchExtraToolsTool',
  'tool.SkillTool',
]

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(`${root}/${path}`, 'utf8'))
}

describe('phase 5 Commands, Skills, Plugins, Hooks, and MCP contract', () => {
  test('publishes only evidence-backed phase 5 capabilities as passed', async () => {
    const [manifest, evidence] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-manifest.json'),
      json('config/harness-capability-evidence.json'),
    ])
    const entries = evidence.capabilities.filter((entry: any) => entry.phase === 5)
    expect(entries.map((entry: any) => entry.id).sort()).toEqual(phaseFiveIds.sort())
    for (const entry of entries) {
      const capability = manifest.capabilities.find((item: any) => item.id === entry.id)
      expect(capability).toBeDefined()
      expect(capability.tested).toBe(true)
      expect(capability.ui_supported).toBe(true)
      expect(capability.last_test_result).toBe('passed')
      expect(capability.invocable).toBe(entry.invocable === undefined ? true : entry.invocable)
      expect(capability.source_evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidenceType: 'runtime' }),
      ]))
    }
  })

  test('publishes the phase 5 transitions in the current gated diff', async () => {
    const [diff, lock] = await Promise.all([
      json('artifacts/capabilities/vendor-capability-diff-phase-5.json'),
      json('config/vendor-lock.json'),
    ])
    expect(diff.previous_vendor_commit).toBe(lock.commit)
    expect(diff.current_vendor_commit).toBe(lock.commit)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed.map((entry: any) => entry.id).sort()).toEqual(phaseFiveIds.sort())
    expect(diff.regressions).toEqual([])
    expect(diff.gate).toEqual({
      unreviewed_additions: [],
      unapproved_regressions: [],
    })
  })

  test('keeps MCP, TUI commands, and command hot reload as explicit expected failures', async () => {
    const manifest = await json('artifacts/capabilities/vendor-capability-manifest.json')
    const gaps = new Map(manifest.known_gaps.map((gap: any) => [gap.id, gap]))
    for (const id of [
      'gap.acp.dynamic-mcp-tools',
      'gap.acp.local-commands',
      'gap.acp.command-hot-reload',
    ]) {
      const gap = gaps.get(id) as Record<string, any> | undefined
      expect(gap).toMatchObject({ status: 'expected_failure' })
      expect(gap?.evidence.length).toBeGreaterThan(0)
      expect(gap?.upstream_strategy).toBeTruthy()
    }
    for (const id of ['tool.MCPTool', 'tool.McpAuthTool']) {
      expect(manifest.capabilities.find((item: any) => item.id === id)).toMatchObject({
        matrix_class: 'C',
        tested: false,
      })
    }
    for (const id of ['tool.ListMcpResourcesTool', 'tool.ReadMcpResourceTool']) {
      expect(manifest.capabilities.find((item: any) => item.id === id)).toMatchObject({
        enabled: false,
        tested: false,
      })
    }
  })

  test('defines durable extension events, migration, UI, and ACP-only runtime wiring', async () => {
    expect(HARNESS_EVENT_TYPES).toEqual(expect.arrayContaining([
      'commands.updated',
      'extensions.updated',
      'extension.configuration_changed',
    ]))
    const [database, migration, supervisor, extensionPage, thread, upstream] = await Promise.all([
      readFile(`${root}/packages/database/src/index.ts`, 'utf8'),
      readFile(`${root}/packages/database/migrations/0005_phase_5.sql`, 'utf8'),
      readFile(`${root}/apps/worker/src/supervisor.ts`, 'utf8'),
      readFile(`${root}/apps/web/src/features/extensions/ExtensionsPage.tsx`, 'utf8'),
      readFile(`${root}/apps/web/src/features/chat/messages/Thread.tsx`, 'utf8'),
      readFile(`${root}/docs/upstream/phase-5-acp-extension-gaps.md`, 'utf8'),
    ])
    expect(database).toContain("version: '0005_phase_5'")
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS available_commands')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS session_extension_state')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS extension_audit_logs')
    expect(supervisor).toContain("from './extensions.ts'")
    expect(supervisor).not.toMatch(/from ['"].*vendor\/claude-code/)
    expect(extensionPage).toContain('data-testid="mcp-registry"')
    expect(extensionPage).toContain('ACP blocked')
    expect(thread).toContain('Slash command palette')
    expect(thread).toContain('<GenericTool part={part} />')
    expect(upstream).toContain('mcpClients: []')
    expect(upstream).toContain('Command hot reload')
  })
})
