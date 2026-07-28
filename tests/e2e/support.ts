import { expect, type APIRequestContext } from '@playwright/test'
import type { SessionRecord } from '@deepharness/protocol'

async function sessionCatalog(request: APIRequestContext): Promise<SessionRecord[]> {
  const response = await request.get('/api/sessions')
  expect(response.ok()).toBe(true)
  const body = await response.json() as { sessions: SessionRecord[] }
  return body.sessions
}

export async function closeOpenSessions(request: APIRequestContext): Promise<void> {
  const open = (await sessionCatalog(request)).filter(session => session.status !== 'closed')
  await Promise.all(open.map(async session => {
    const response = await request.post(`/api/sessions/${session.id}/close`, {
      data: {},
      headers: { 'idempotency-key': crypto.randomUUID() },
    })
    expect(response.ok()).toBe(true)
  }))
  await expect.poll(async () => {
    const sessions = await sessionCatalog(request)
    return open.every(session => sessions.find(current => current.id === session.id)?.status === 'closed')
  }, { timeout: 30_000 }).toBe(true)
}
