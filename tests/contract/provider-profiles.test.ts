import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  PROVIDER_IDS,
  providerCredentialAlternatives,
  type ProviderId,
} from '../../apps/worker/src/provider.ts'

const root = process.cwd()

describe('manual provider profiles', () => {
  test('defines all seven profiles with auditable credential alternatives', async () => {
    const document = JSON.parse(
      await readFile(`${root}/config/provider-profiles.json`, 'utf8'),
    ) as { schemaVersion: number; profiles: Array<Record<string, any>> }
    expect(document.schemaVersion).toBe(1)
    expect(document.profiles.map(profile => profile.id)).toEqual([...PROVIDER_IDS])
    for (const profile of document.profiles) {
      const providerId = profile.id as ProviderId
      expect(profile.credentialAlternatives).toEqual(providerCredentialAlternatives[providerId])
      expect(new Set(profile.credentialEnvironment)).toEqual(
        new Set(profile.credentialAlternatives.flat()),
      )
      expect(profile.smokeCommand).toContain('compose.providers.yaml')
      expect(profile.smokeCommand).toContain('--profile smoke-')
    }
    expect(document.profiles[0]?.automatedTest).toBe('fake_passed')
    for (const profile of document.profiles.slice(1)) {
      expect(profile.automatedTest).toBe('config_validated')
    }
  })

  test('keeps smoke services manually profiled and cost-bounded to one timed prompt', async () => {
    const compose = await readFile(`${root}/compose.providers.yaml`, 'utf8')
    for (const profile of ['anthropic', 'bedrock', 'vertex', 'foundry', 'openai', 'gemini', 'grok']) {
      expect(compose).toContain(`provider-smoke-${profile}:`)
      expect(compose).toContain(`profiles: [smoke-${profile}]`)
    }
    expect(compose).toContain('PROVIDER_SMOKE_TIMEOUT_MS')
    expect(compose).toContain('MAX_THINKING_TOKENS')
    expect(compose).toContain('read_only: true')
  })

  test('fails on missing credentials before trying to start the ACP entrypoint', async () => {
    const child = Bun.spawn([
      'bun',
      'run',
      'apps/worker/src/provider-smoke.ts',
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PROVIDER_SMOKE_ID: 'openai-compatible',
        CLAUDE_CODE_USE_OPENAI: '1',
        AGENT_ENTRYPOINT: '/definitely/missing/agent.js',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('Provider openai-compatible credentials are missing')
    expect(stderr).not.toContain('ACP process exited')
  })
})
