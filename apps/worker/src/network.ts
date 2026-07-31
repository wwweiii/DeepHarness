import { isIP } from 'node:net'

export type OutboundNetworkPolicy = 'deny' | 'public-web' | 'allowlist'

export interface NetworkDecision {
  allowed: boolean
  reason: string
  policy: OutboundNetworkPolicy
  host: string | null
  url: string | null
}

const INTERNAL_HOSTS = new Set([
  'gateway',
  'worker',
  'postgres',
  'test-model',
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'instance-data.ec2.internal',
])

function parsePolicy(value: string | undefined): OutboundNetworkPolicy {
  if (value === 'deny' || value === 'allowlist' || value === 'public-web') return value
  return 'public-web'
}

export function outboundNetworkPolicy(env: NodeJS.ProcessEnv = process.env): OutboundNetworkPolicy {
  return parsePolicy(env.OUTBOUND_NETWORK_POLICY)
}

export function outboundAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OUTBOUND_NETWORK_ALLOWLIST ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const a = parts[0]!
  const b = parts[1]!
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0)
    || a >= 224
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::' || normalized === '::1') return true
  // IPv4-mapped IPv6 literals inherit the IPv4 boundary.
  const mapped = normalized.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped && isPrivateIpv4(mapped[1]!)) return true
  // WHATWG URL canonicalization commonly rewrites dotted mapped addresses to
  // hexadecimal (for example ::ffff:7f00:1). Conservatively reject all
  // IPv4-mapped IPv6 literals rather than risk bypassing the IPv4 checks.
  if (normalized.startsWith('::ffff:') || normalized.includes(':ffff:')) return true
  return normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8')
    || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!host || INTERNAL_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.localhost')
    || host.endsWith('.internal')) return true
  const family = isIP(host)
  if (family === 4) return isPrivateIpv4(host)
  if (family === 6) return isPrivateIpv6(host)
  return false
}

function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  return allowlist.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))))
}

function candidateUrl(input: Record<string, unknown>): string | null {
  const values = [input.url, input.uri, input.href, input.target]
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  // Search tools may expose a list of URLs under a generic query field. A
  // query itself is not a host target and is therefore handled by policy only.
  return null
}

export function evaluateOutboundRequest(
  toolName: string,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): NetworkDecision {
  const policy = outboundNetworkPolicy(env)
  const urlText = candidateUrl(input)
  const logical = toolName.toLowerCase().replace(/[^a-z0-9]/g, '')
  const isWebTool = logical === 'webfetch' || logical === 'webfetchtool'
    || logical === 'websearch' || logical === 'websearchtool'
    || logical === 'webbrowser' || logical === 'webbrowsertool'
  if (!isWebTool) return { allowed: true, reason: 'not_web_tool', policy, host: null, url: null }
  if (policy === 'deny') return { allowed: false, reason: 'OUTBOUND_NETWORK_POLICY_DENY', policy, host: null, url: urlText }
  if (!urlText) {
    if (policy === 'allowlist') {
      return { allowed: false, reason: 'OUTBOUND_NETWORK_URL_REQUIRED_FOR_ALLOWLIST', policy, host: null, url: null }
    }
    return { allowed: true, reason: 'search_or_query_without_explicit_url', policy, host: null, url: null }
  }
  let parsed: URL
  try {
    parsed = new URL(urlText)
  } catch {
    return { allowed: false, reason: 'OUTBOUND_NETWORK_INVALID_URL', policy, host: null, url: urlText }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'OUTBOUND_NETWORK_PROTOCOL_BLOCKED', policy, host: parsed.hostname, url: urlText }
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  if (isBlockedHost(host)) {
    return { allowed: false, reason: 'OUTBOUND_NETWORK_PRIVATE_TARGET', policy, host, url: urlText }
  }
  if (policy === 'allowlist' && !hostMatchesAllowlist(host, outboundAllowlist(env))) {
    return { allowed: false, reason: 'OUTBOUND_NETWORK_HOST_NOT_ALLOWLISTED', policy, host, url: urlText }
  }
  return { allowed: true, reason: 'allowed', policy, host, url: urlText }
}
