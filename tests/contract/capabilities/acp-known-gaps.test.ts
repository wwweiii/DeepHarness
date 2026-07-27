import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const reportPath = `${process.cwd()}/artifacts/capabilities/vendor-acp-probe-report.json`

describe('ACP runtime and expected-failure contracts', () => {
  test('runs initialize and new session against the real ccb-bun process', async () => {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    expect(report.initialize.protocolVersion).toBeDefined()
    expect(report.initialize.agentInfo.name).toBe('claude-code')
    expect(report.initialize.agentInfo.version).toBe('2.1.888')
    expect(typeof report.new_session.sessionId).toBe('string')
    expect(report.new_session.sessionId.length).toBeGreaterThan(0)
    expect(Array.isArray(report.new_session.modes.availableModes)).toBe(true)
    expect(Array.isArray(report.new_session.models.availableModels)).toBe(true)
  })

  test('keeps every known ACP gap as a reproducible expected failure', async () => {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    expect(report.gaps.map((gap: any) => gap.id).sort()).toEqual([
      'gap.acp.agent-version-drift',
      'gap.acp.dynamic-mcp-tools',
      'gap.acp.image-input',
      'gap.acp.local-commands',
    ])
    for (const gap of report.gaps) {
      expect(gap.status).toBe('expected_failure')
      expect(gap.evidence.length).toBeGreaterThan(0)
      expect(gap.upstream_strategy).toContain('upstream ACP fix')
    }
  })

  test('records command reachability instead of treating source definitions as ACP commands', async () => {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    expect(report.available_commands.length).toBeGreaterThan(0)
    const localGap = report.gaps.find((gap: any) => gap.id === 'gap.acp.local-commands')
    expect(localGap.summary).toContain('local/local-jsx commands were absent')
  })
})
