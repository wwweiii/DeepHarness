import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectTranscript, inspectTranscriptContext } from '../../apps/worker/src/transcript.ts'

test('classifies missing, corrupt, empty, and valid transcripts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'deepharness-transcript-'))
  const previousRoot = process.env.AGENT_TRANSCRIPT_ROOT
  process.env.AGENT_TRANSCRIPT_ROOT = root

  try {
    const nested = path.join(root, 'workspace')
    await mkdir(nested, { recursive: true })

    await expect(inspectTranscript('missing-session')).rejects.toThrow(
      'TRANSCRIPT_MISSING:missing-session',
    )

    await writeFile(path.join(nested, 'corrupt-session.jsonl'), '{"type":"broken"\n', 'utf8')
    await expect(inspectTranscript('corrupt-session')).rejects.toThrow(
      'TRANSCRIPT_CORRUPT:corrupt-session:line:1',
    )

    await writeFile(path.join(nested, 'empty-session.jsonl'), '\n', 'utf8')
    await expect(inspectTranscript('empty-session')).rejects.toThrow(
      'TRANSCRIPT_EMPTY:empty-session',
    )

    const valid = path.join(nested, 'valid-session.jsonl')
    await writeFile(valid, [
      JSON.stringify({
        type: 'user',
        uuid: 'user-checkpoint',
        timestamp: '2026-07-30T10:00:00.000Z',
      }),
      JSON.stringify({ type: 'assistant', uuid: 'assistant-message' }),
      JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary',
        timestamp: '2026-07-30T10:01:00.000Z',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 172_000,
          messagesSummarized: 28,
          sensitiveSummary: 'must never be projected',
        },
      }),
    ].join('\n') + '\n', 'utf8')
    await expect(inspectTranscript('valid-session')).resolves.toBe(valid)
    const context = await inspectTranscriptContext('valid-session')
    expect(context).toMatchObject({
      recordCount: 3,
      userCheckpointCount: 1,
      compactCount: 1,
      lastUserMessageId: 'user-checkpoint',
      latestCompact: {
        boundaryId: 'compact-boundary',
        trigger: 'manual',
        preTokens: 172_000,
        messagesSummarized: 28,
      },
      updatedAt: '2026-07-30T10:01:00.000Z',
    })
    expect(JSON.stringify(context)).not.toContain('sensitiveSummary')
    expect(JSON.stringify(context)).not.toContain('must never be projected')
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_TRANSCRIPT_ROOT
    else process.env.AGENT_TRANSCRIPT_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})
