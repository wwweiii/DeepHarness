import { expect, test } from 'bun:test'
import type { HarnessEvent, SessionSnapshot } from '@deepharness/protocol'

const baseUrl = process.env.TEST_BASE_URL
const stackTest = baseUrl ? test : test.skip

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

async function snapshot(): Promise<SessionSnapshot> {
  return json<SessionSnapshot>('/api/session')
}

async function waitFor(
  predicate: (value: SessionSnapshot) => boolean,
  timeoutMs = 60_000,
): Promise<SessionSnapshot> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await snapshot()
    if (predicate(value)) return value
    await Bun.sleep(100)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function prompt(sessionId: string, text: string): Promise<string> {
  const result = await json<{ turnId: string }>(`/api/sessions/${sessionId}/prompts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ text }),
  })
  return result.turnId
}

function turnEvents(value: SessionSnapshot, turnId: string): HarnessEvent[] {
  return value.events.filter(event => event.turnId === turnId)
}

function text(events: HarnessEvent[]): string {
  return events
    .filter(event => event.type === 'assistant.text_delta')
    .map(event => String(event.payload.text ?? ''))
    .join('')
}

stackTest('phase 1 vertical stack streams, reads workspace, cancels, and replays', async () => {
  let value = await snapshot()
  if (!value.session) {
    await json('/api/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify({ permissionMode: 'acceptEdits' }),
    })
  }
  value = await waitFor(current => current.session?.status === 'idle')
  const sessionId = value.session!.id
  expect(value.session?.agentSessionId).toBeTruthy()

  const streamTurn = await prompt(sessionId, 'Reply with the exact words STREAM OK.')
  value = await waitFor(current => turnEvents(current, streamTurn)
    .some(event => event.type === 'turn.completed'))
  const streamEvents = turnEvents(value, streamTurn)
  expect(text(streamEvents)).toContain('STREAM OK')
  expect(streamEvents.filter(event => event.type === 'assistant.text_delta').length).toBeGreaterThan(1)

  const readTurn = await prompt(
    sessionId,
    'Read phase-1-marker.txt from the workspace and report its marker.',
  )
  value = await waitFor(current => turnEvents(current, readTurn)
    .some(event => event.type === 'turn.completed'))
  const readText = text(turnEvents(value, readTurn))
  expect(readText).toMatch(/DEEPHARNESS_PHASE_1_WORKSPACE_READ_OK|File unchanged since last read/)
  expect(text(value.events)).toContain('DEEPHARNESS_PHASE_1_WORKSPACE_READ_OK')

  const cancelTurn = await prompt(sessionId, '[slow] continue until cancelled')
  await waitFor(current => turnEvents(current, cancelTurn)
    .some(event => event.type === 'assistant.text_delta'))
  await json(`/api/sessions/${sessionId}/cancel`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  value = await waitFor(current => turnEvents(current, cancelTurn)
    .some(event => event.type === 'turn.completed'))
  const cancelEvents = turnEvents(value, cancelTurn)
  expect(cancelEvents.find(event => event.type === 'turn.completed')?.payload.stopReason)
    .toBe('cancelled')
  expect(cancelEvents.some(event => event.type === 'session.interrupted')).toBe(true)

  const replay = await snapshot()
  expect(replay.events.map(event => event.id)).toEqual(value.events.map(event => event.id))
  expect(replay.events.map(event => event.seq)).toEqual(
    [...replay.events].map(event => event.seq).sort((left, right) => left - right),
  )
  expect(new Set(replay.events.map(event => event.seq)).size).toBe(replay.events.length)
})
