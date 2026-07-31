function durationMs(value: string): number | null {
  const match = value.trim().match(/^@every\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i)
  if (!match) return null
  const number = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return Number.isFinite(number) && number > 0 ? Math.max(1, number * factor) : null
}

function cronFields(expression: string): string[] | null {
  const fields = expression.trim().split(/\s+/)
  return fields.length === 5 ? fields : null
}

function matchesField(value: number, field: string, min: number, max: number): boolean {
  if (field === '*') return true
  return field.split(',').some(part => {
    const [rangeValue, stepText] = part.split('/')
    const range = rangeValue ?? ''
    const step = stepText ? Number(stepText) : 1
    if (!Number.isFinite(step) || step <= 0) return false
    const [startText, endText] = range.split('-')
    const start = startText === '*' ? min : Number(startText)
    const end = endText === undefined ? start : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return false
    if (value < start || value > end) return false
    return (value - start) % step === 0
  })
}

function zonedParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, minute: 'numeric', hour: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short', hourCycle: 'h23',
    })
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return { minute: Number(parts.minute ?? 0), hour: Number(parts.hour ?? 0), day: Number(parts.day ?? 0), month: Number(parts.month ?? 0), weekday: weekdays.indexOf(parts.weekday ?? '') }
  } catch {
    return null
  }
}

/** Returns the first occurrence strictly after `after`. Supports five-field cron and @every/@once. */
export function nextCronOccurrence(expression: string, after: Date, timezone = 'UTC'): Date | null {
  const trimmed = expression.trim()
  if (trimmed === '@once') return null
  const duration = durationMs(trimmed)
  if (duration !== null) return new Date(after.getTime() + duration)
  const fields = cronFields(trimmed)
  if (!fields) return null
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000)
  const max = start.getTime() + 366 * 24 * 60 * 60 * 1_000
  for (let cursor = start.getTime(); cursor <= max; cursor += 60_000) {
    const parts = zonedParts(new Date(cursor), timezone)
    if (!parts) return null
    if (matchesField(parts.minute, fields[0]!, 0, 59)
      && matchesField(parts.hour, fields[1]!, 0, 23)
      && matchesField(parts.day, fields[2]!, 1, 31)
      && matchesField(parts.month, fields[3]!, 1, 12)
      && matchesField(parts.weekday, fields[4]!, 0, 6)) return new Date(cursor)
  }
  return null
}

export function missedCronOccurrences(expression: string, scheduledAt: Date, now: Date, timezone: string, policy: 'run_once' | 'skip' | 'run_all', maxCatchUp: number): Date[] {
  if (policy === 'skip') return []
  const result: Date[] = []
  let cursor = scheduledAt
  const limit = policy === 'run_once' ? 1 : Math.max(1, Math.min(maxCatchUp, 100))
  while (cursor <= now && result.length < limit) {
    result.push(cursor)
    const next = nextCronOccurrence(expression, cursor, timezone)
    if (!next) break
    cursor = next
  }
  return result
}
