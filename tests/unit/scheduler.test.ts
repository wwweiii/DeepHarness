import { describe, expect, test } from 'bun:test'
import { missedCronOccurrences, nextCronOccurrence } from '../../apps/gateway/src/scheduler.ts'

describe('phase 7 durable scheduler clock semantics', () => {
  test('supports fixed intervals and one-shot jobs', () => {
    const base = new Date('2026-07-31T00:00:00.000Z')
    expect(nextCronOccurrence('@every 2s', base)?.toISOString()).toBe('2026-07-31T00:00:02.000Z')
    expect(nextCronOccurrence('@once', base)).toBeNull()
  })

  test('evaluates five-field schedules in an explicit IANA timezone', () => {
    const base = new Date('2026-07-31T00:00:00.000Z')
    expect(nextCronOccurrence('0 9 * * 1-5', base, 'Asia/Shanghai')?.toISOString())
      .toBe('2026-07-31T01:00:00.000Z')
  })

  test('applies misfire policy and catch-up bounds deterministically', () => {
    const scheduled = new Date('2026-07-31T00:00:00.000Z')
    const now = new Date('2026-07-31T00:00:05.000Z')
    expect(missedCronOccurrences('@every 1s', scheduled, now, 'UTC', 'skip', 10)).toEqual([])
    expect(missedCronOccurrences('@every 1s', scheduled, now, 'UTC', 'run_once', 10)).toHaveLength(1)
    expect(missedCronOccurrences('@every 1s', scheduled, now, 'UTC', 'run_all', 3)).toHaveLength(3)
  })
})
