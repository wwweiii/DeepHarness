import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

describe('phase 8 Artifacts, LSP, Web, and platform contract', () => {
  test('defines durable projections and bounded artifact delivery', async () => {
    const [migration, protocol, store, server, worker, artifactHelper] = await Promise.all([
      readFile(`${root}/packages/database/migrations/0008_phase_8.sql`, 'utf8'),
      readFile(`${root}/packages/protocol/src/index.ts`, 'utf8'),
      readFile(`${root}/apps/gateway/src/store.ts`, 'utf8'),
      readFile(`${root}/apps/gateway/src/server.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/supervisor.ts`, 'utf8'),
      readFile(`${root}/apps/worker/src/artifacts.ts`, 'utf8'),
    ])
    for (const table of ['artifacts', 'lsp_diagnostics', 'lsp_locations', 'web_sources', 'platform_integrations']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    for (const field of ['kind', 'workspace_relative_path', 'content_hash', 'preview_status']) expect(migration).toContain(field)
    for (const event of ['artifact.created', 'artifact.rejected', 'image.output', 'lsp.diagnostics_updated', 'lsp.location', 'web.source_observed', 'platform.updated', 'integration.updated']) {
      expect(protocol).toContain(`'${event}'`)
    }
    for (const route of ['/artifacts', '/lsp/diagnostics', '/lsp/locations', '/web/sources', '/platform']) expect(server).toContain(route)
    expect(server).toContain('content-security-policy')
    expect(server).toContain('content-disposition')
    expect(artifactHelper).toContain('ARTIFACT_PATH_OUTSIDE_WORKSPACE')
    expect(artifactHelper).toContain('ARTIFACT_SIZE_LIMIT_EXCEEDED')
    expect(worker).not.toMatch(/vendor\/claude-code/)
    expect(store).toContain('lsp_diagnostics')
  })

  test('keeps optional Docker profiles explicit and base runtime dependency-free', async () => {
    const [compose, dockerfile] = await Promise.all([
      readFile(`${root}/compose.platforms.yaml`, 'utf8'),
      readFile(`${root}/docker/service.Dockerfile`, 'utf8'),
    ])
    expect(compose).toContain('profiles: [lsp]')
    expect(compose).toContain('profiles: [browser]')
    expect(compose).toContain('ENABLE_LSP_TOOL: "1"')
    expect(compose).toContain('AGENT_PLUGIN_DIRS: /opt/deepharness/typescript-lsp-plugin')
    expect(compose).toContain('VENDOR_ACP_LSP_BOOTSTRAP: "0"')
    expect(compose).toContain('WEB_BROWSER_PROFILE: chromium')
    expect(compose).toContain('VENDOR_WEB_BROWSER_COMPILED: "0"')
    expect(dockerfile).toContain('AS worker-lsp')
    expect(dockerfile).toContain('AS worker-browser')
    expect(dockerfile).toContain('typescript-language-server')
    expect(dockerfile).toContain('chromium')
  })

  test('retains image input and host-platform gaps as auditable evidence', async () => {
    const [evidence, upstream] = await Promise.all([
      readFile(`${root}/config/harness-capability-evidence.json`, 'utf8'),
      readFile(`${root}/docs/upstream/phase-8-platform-gaps.md`, 'utf8'),
    ])
    expect(evidence).toContain('gap.acp.image-input')
    expect(evidence).toContain('gap.platform.ssh-remote')
    expect(evidence).toContain('gap.platform.voice')
    expect(upstream).toContain('image input')
    expect(upstream).toContain('SSH')
    expect(upstream).toContain('voice')
    expect(upstream).toContain("unknown option '--acp'")
    expect(upstream).toContain('WEB_BROWSER_TOOL` compiled=false')
  })

  test('publishes Phase 8 capability truth without unapproved diff regressions', async () => {
    const [manifest, diff] = await Promise.all([
      readFile(`${root}/artifacts/capabilities/vendor-capability-manifest.json`, 'utf8').then(JSON.parse),
      readFile(`${root}/artifacts/capabilities/vendor-capability-diff-phase-8.json`, 'utf8').then(JSON.parse),
    ])
    const capability = (id: string) => manifest.capabilities.find((item: { id: string }) => item.id === id)
    expect(capability('tool.ArtifactTool')).toMatchObject({ enabled: true, invocable: true, tested: true, last_test_result: 'passed' })
    expect(capability('tool.LSPTool')).toMatchObject({ enabled: false, invocable: false, tested: true, last_test_result: 'passed' })
    expect(capability('tool.WebBrowserTool')).toMatchObject({ enabled: false, invocable: false, tested: true, last_test_result: 'passed' })
    for (const id of [
      'tool.SendUserFileTool', 'tool.ReviewArtifactTool', 'tool.SnipTool',
      'tool.TerminalCaptureTool', 'tool.PowerShellTool',
    ]) expect(capability(id)).toMatchObject({ invocable: false, tested: true })
    expect(manifest.known_gaps.find((item: { id: string }) => item.id === 'gap.acp.lsp-bootstrap'))
      .toMatchObject({ status: 'expected_failure' })
    expect(diff.gate).toEqual({ unreviewed_additions: [], unapproved_regressions: [] })
    expect(diff.changed.length).toBeGreaterThan(0)
  })
})
