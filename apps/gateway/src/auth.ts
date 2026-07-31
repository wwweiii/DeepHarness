import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const sessionCookieName = 'deepharness_session'
export const csrfCookieName = 'deepharness_csrf'

export type AuthConfig = {
  enabled: boolean
  secureCookies: boolean
  sessionTtlMs: number
  loginWindowMs: number
  loginMaxAttempts: number
  writeWindowMs: number
  writeMaxRequests: number
  metricsToken: string | null
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  return {
    enabled: booleanEnv(env.AUTH_ENABLED, env.NODE_ENV === 'production'),
    secureCookies: booleanEnv(env.AUTH_COOKIE_SECURE, env.NODE_ENV === 'production'),
    sessionTtlMs: boundedNumber(env.AUTH_SESSION_TTL_MS, 12 * 60 * 60 * 1_000, 5 * 60 * 1_000, 30 * 24 * 60 * 60 * 1_000),
    loginWindowMs: boundedNumber(env.AUTH_LOGIN_WINDOW_MS, 15 * 60 * 1_000, 60 * 1_000, 24 * 60 * 60 * 1_000),
    loginMaxAttempts: boundedNumber(env.AUTH_LOGIN_MAX_ATTEMPTS, 5, 1, 100),
    writeWindowMs: boundedNumber(env.API_RATE_WINDOW_MS, 60 * 1_000, 10 * 1_000, 60 * 60 * 1_000),
    writeMaxRequests: boundedNumber(env.API_RATE_MAX_REQUESTS, 120, 10, 10_000),
    metricsToken: env.METRICS_TOKEN?.trim() || null,
  }
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback
}

export type RateLimitDecision = {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

type RateEntry = { count: number; resetAt: number }

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateEntry>()

  constructor(private readonly windowMs: number, private readonly max: number) {}

  consume(key: string, now = Date.now()): RateLimitDecision {
    const current = this.entries.get(key)
    const entry = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + this.windowMs }
      : current
    entry.count += 1
    this.entries.set(key, entry)
    if (this.entries.size > 10_000) {
      for (const [candidate, value] of this.entries) {
        if (value.resetAt <= now) this.entries.delete(candidate)
      }
    }
    return {
      allowed: entry.count <= this.max,
      remaining: Math.max(0, this.max - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1_000)),
    }
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown'
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key) result[key] = decodeURIComponent(value)
  }
  return result
}

export function cookieValue(name: string, value: string, options: {
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  path?: string
} = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`)
  if (options.httpOnly !== false) parts.push('HttpOnly')
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`)
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function hasCsrfToken(
  request: Request,
  cookies: Record<string, string>,
  expectedHash?: string,
): boolean {
  const header = request.headers.get('x-csrf-token')
  const cookie = cookies[csrfCookieName]
  if (!cookie || !constantTimeEqual(header ?? undefined, cookie)) return false
  return expectedHash === undefined || constantTimeEqual(tokenHash(cookie), expectedHash)
}

export function isSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

export function shouldSkipAuthentication(pathname: string): boolean {
  return pathname === '/healthz'
    || pathname === '/readyz'
    || pathname.startsWith('/health/')
    || pathname === '/metrics'
    || pathname.startsWith('/api/auth/')
}

export function redact(value: string): string {
  return value
    .replace(/(authorization|cookie|password|token|secret|api[_-]?key)\s*[:=]\s*[^,\s}]+/gi, '$1=<redacted>')
    .slice(0, 2_000)
}
