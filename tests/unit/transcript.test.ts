import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inspectTranscript } from '../../apps/worker/src/transcript.ts'

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
    await writeFile(valid, '{"type":"user"}\n{"type":"assistant"}\n', 'utf8')
    await expect(inspectTranscript('valid-session')).resolves.toBe(valid)
  } finally {
    if (previousRoot === undefined) delete process.env.AGENT_TRANSCRIPT_ROOT
    else process.env.AGENT_TRANSCRIPT_ROOT = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})
