import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

function transcriptRoot(): string {
  return path.resolve(process.env.AGENT_TRANSCRIPT_ROOT ?? '/home/agent/.claude/projects')
}

export interface TranscriptContextState {
  path: string
  recordCount: number
  userCheckpointCount: number
  compactCount: number
  lastUserMessageId: string | null
  latestCompact: {
    boundaryId: string | null
    trigger: 'manual' | 'auto' | 'unknown'
    preTokens: number | null
    messagesSummarized: number | null
    timestamp: string | null
  } | null
  updatedAt: string | null
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

export async function findTranscript(agentSessionId: string): Promise<string | null> {
  const root = transcriptRoot()
  let entries: string[]
  try {
    entries = await readdir(root, { recursive: true }) as string[]
  } catch {
    return null
  }
  const relative = entries.find(entry => path.basename(entry) === `${agentSessionId}.jsonl`)
  if (!relative) return null
  const transcript = path.resolve(root, relative)
  const withinRoot = path.relative(root, transcript)
  return withinRoot.startsWith('..') || path.isAbsolute(withinRoot) ? null : transcript
}

export async function inspectTranscript(agentSessionId: string): Promise<string> {
  return (await inspectTranscriptContext(agentSessionId)).path
}

export async function inspectTranscriptContext(agentSessionId: string): Promise<TranscriptContextState> {
  const transcript = await findTranscript(agentSessionId)
  if (!transcript) throw new Error(`TRANSCRIPT_MISSING:${agentSessionId}`)
  const lines = createInterface({
    input: createReadStream(transcript, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let lineNumber = 0
  let records = 0
  let userCheckpointCount = 0
  let compactCount = 0
  let lastUserMessageId: string | null = null
  let updatedAt: string | null = null
  let latestCompact: TranscriptContextState['latestCompact'] = null
  for await (const line of lines) {
    lineNumber += 1
    if (!line.trim()) continue
    try {
      const record = objectValue(JSON.parse(line))
      records += 1
      updatedAt = timestampOrNull(record.timestamp) ?? updatedAt
      if (record.type === 'user' && record.isMeta !== true && typeof record.uuid === 'string') {
        userCheckpointCount += 1
        lastUserMessageId = record.uuid
      }
      if (record.type === 'system' && record.subtype === 'compact_boundary') {
        const metadata = Object.keys(objectValue(record.compactMetadata)).length > 0
          ? objectValue(record.compactMetadata)
          : objectValue(record.compact_metadata)
        compactCount += 1
        latestCompact = {
          boundaryId: typeof record.uuid === 'string' ? record.uuid : null,
          trigger: metadata.trigger === 'manual' || metadata.trigger === 'auto'
            ? metadata.trigger
            : 'unknown',
          preTokens: numberOrNull(metadata.preTokens ?? metadata.pre_tokens),
          messagesSummarized: numberOrNull(
            metadata.messagesSummarized ?? metadata.messages_summarized,
          ),
          timestamp: timestampOrNull(record.timestamp),
        }
      }
    } catch {
      throw new Error(`TRANSCRIPT_CORRUPT:${agentSessionId}:line:${lineNumber}`)
    }
  }
  if (records === 0) throw new Error(`TRANSCRIPT_EMPTY:${agentSessionId}`)
  return {
    path: transcript,
    recordCount: records,
    userCheckpointCount,
    compactCount,
    lastUserMessageId,
    latestCompact,
    updatedAt,
  }
}
