import { describe, expect, test } from 'bun:test'
import {
  FixedWindowRateLimiter,
  csrfCookieName,
  cookieValue,
  hasCsrfToken,
  parseCookies,
  readAuthConfig,
  sessionCookieName,
  tokenHash,
} from '../../apps/gateway/src/auth.ts'

describe('phase 9 authentication helpers', () => {
  test('parses and serializes URL-safe cookies', () => {
    const header = `${cookieValue(sessionCookieName, 'session value', { httpOnly: true })}; ${cookieValue(csrfCookieName, 'csrf', { httpOnly: false })}`
    const cookies = parseCookies(header)
    expect(cookies[sessionCookieName]).toBe('session value')
    expect(cookies[csrfCookieName]).toBe('csrf')
    expect(header).toContain('HttpOnly')
  })

  test('requires a matching CSRF cookie and header', () => {
    const request = new Request('http://gateway.test/api/write', {
      method: 'POST',
      headers: {
        cookie: `${csrfCookieName}=csrf-token`,
        'x-csrf-token': 'csrf-token',
      },
    })
    expect(hasCsrfToken(request, parseCookies(request.headers.get('cookie')))).toBe(true)
    const bad = new Request(request, { headers: { cookie: `${csrfCookieName}=csrf-token`, 'x-csrf-token': 'other' } })
    expect(hasCsrfToken(bad, parseCookies(bad.headers.get('cookie')))).toBe(false)
    expect(hasCsrfToken(request, parseCookies(request.headers.get('cookie')), tokenHash('csrf-token'))).toBe(true)
    expect(hasCsrfToken(request, parseCookies(request.headers.get('cookie')), tokenHash('other'))).toBe(false)
  })

  test('returns deterministic fixed-window decisions and cleans expired keys', () => {
    const limiter = new FixedWindowRateLimiter(1_000, 2)
    expect(limiter.consume('ip', 0).allowed).toBe(true)
    expect(limiter.consume('ip', 1).allowed).toBe(true)
    expect(limiter.consume('ip', 2).allowed).toBe(false)
    expect(limiter.consume('ip', 1_001).allowed).toBe(true)
  })

  test('defaults authentication off outside production and bounds unsafe values', () => {
    const config = readAuthConfig({ NODE_ENV: 'test', AUTH_LOGIN_MAX_ATTEMPTS: '0', API_RATE_MAX_REQUESTS: '999999' })
    expect(config.enabled).toBe(false)
    expect(config.loginMaxAttempts).toBe(1)
    expect(config.writeMaxRequests).toBe(10_000)
  })
})
