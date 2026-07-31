import { describe, expect, test } from 'bun:test'
import { evaluateOutboundRequest, isBlockedHost } from '../../apps/worker/src/network.ts'

describe('phase 8 outbound network policy', () => {
  test('blocks Docker metadata, private literals, and internal service names', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true)
    expect(isBlockedHost('10.0.0.8')).toBe(true)
    expect(isBlockedHost('169.254.169.254')).toBe(true)
    expect(isBlockedHost('100.64.0.1')).toBe(true)
    expect(isBlockedHost('fd00::1')).toBe(true)
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true)
    expect(isBlockedHost('gateway')).toBe(true)
    expect(isBlockedHost('api.internal')).toBe(true)
    expect(isBlockedHost('example.com')).toBe(false)
  })

  test('enforces deny and allowlist policies for all logical Web tools', () => {
    expect(evaluateOutboundRequest('WebFetch', { url: 'https://example.com' }, {
      OUTBOUND_NETWORK_POLICY: 'deny',
    }).reason).toBe('OUTBOUND_NETWORK_POLICY_DENY')
    expect(evaluateOutboundRequest('WebFetch', { url: 'https://example.com' }, {
      OUTBOUND_NETWORK_POLICY: 'allowlist', OUTBOUND_NETWORK_ALLOWLIST: 'example.com',
    }).allowed).toBe(true)
    expect(evaluateOutboundRequest('WebBrowserTool', { url: 'https://other.example' }, {
      OUTBOUND_NETWORK_POLICY: 'allowlist', OUTBOUND_NETWORK_ALLOWLIST: 'example.com',
    }).reason).toBe('OUTBOUND_NETWORK_HOST_NOT_ALLOWLISTED')
    expect(evaluateOutboundRequest('WebSearch', { url: 'http://127.0.0.1:8080' }, {
      OUTBOUND_NETWORK_POLICY: 'public-web',
    }).reason).toBe('OUTBOUND_NETWORK_PRIVATE_TARGET')
  })

  test('does not claim a URL-less search has a host boundary', () => {
    const decision = evaluateOutboundRequest('WebSearch', { query: 'DeepHarness' }, {
      OUTBOUND_NETWORK_POLICY: 'public-web',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.host).toBeNull()
    expect(decision.reason).toBe('search_or_query_without_explicit_url')
  })
})
