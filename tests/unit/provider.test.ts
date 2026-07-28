import { describe, expect, test } from 'bun:test'
import {
  activeProviderStatus,
  agentEnvironment,
  providerCredentialsConfigured,
  selectedProviderId,
} from '../../apps/worker/src/provider.ts'

describe('provider selection and credentials', () => {
  test('defaults to Anthropic and requires a real credential variable', () => {
    expect(selectedProviderId({})).toBe('anthropic')
    expect(activeProviderStatus({})).toEqual({
      providerId: 'anthropic',
      credentialStatus: 'missing',
    })
    expect(providerCredentialsConfigured('anthropic', { ANTHROPIC_API_KEY: 'test' })).toBe(true)
    expect(providerCredentialsConfigured('anthropic', { ANTHROPIC_AUTH_TOKEN: 'test' })).toBe(true)
  })

  test('rejects ambiguous selectors instead of silently choosing a provider', () => {
    expect(() => selectedProviderId({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
    })).toThrow('Multiple provider selectors are enabled')
  })

  test('requires complete credential alternatives', () => {
    expect(providerCredentialsConfigured('bedrock', {
      AWS_ACCESS_KEY_ID: 'test',
      AWS_REGION: 'us-east-1',
    })).toBe(false)
    expect(providerCredentialsConfigured('bedrock', {
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      AWS_REGION: 'us-east-1',
    })).toBe(true)
    expect(providerCredentialsConfigured('openai-compatible', {
      OPENAI_API_KEY: 'test',
      OPENAI_BASE_URL: 'https://example.invalid',
    })).toBe(false)
    expect(providerCredentialsConfigured('openai-compatible', {
      OPENAI_API_KEY: 'test',
      OPENAI_BASE_URL: 'https://example.invalid',
      OPENAI_MODEL: 'test-model',
    })).toBe(true)
  })

  test('passes only explicitly allowed variables to the Agent', () => {
    expect(agentEnvironment({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'secret',
      CLAUDE_CODE_ENABLE_TASKS: '1',
      UNRELATED_SECRET: 'must-not-pass',
    })).toEqual({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'secret',
      CLAUDE_CODE_ENABLE_TASKS: '1',
    })
  })
})
