import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

function transcriptRoot(): string {
  return path.resolve(process.env.AGENT_TRANSCRIPT_ROOT ?? '/home/agent/.claude/projects')
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
  const transcript = await findTranscript(agentSessionId)
  if (!transcript) throw new Error(`TRANSCRIPT_MISSING:${agentSessionId}`)
  const lines = createInterface({
    input: createReadStream(transcript, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  let lineNumber = 0
  let records = 0
  for await (const line of lines) {
    lineNumber += 1
    if (!line.trim()) continue
    try {
      JSON.parse(line)
      records += 1
    } catch {
      throw new Error(`TRANSCRIPT_CORRUPT:${agentSessionId}:line:${lineNumber}`)
    }
  }
  if (records === 0) throw new Error(`TRANSCRIPT_EMPTY:${agentSessionId}`)
  return transcript
}
