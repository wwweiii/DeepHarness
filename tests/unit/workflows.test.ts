import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverWorkflows, workflowDefinitionId } from '../../apps/worker/src/workflows.ts'

describe('workspace workflow identity', () => {
  test('uses a stable UUID per workflow and Harness session', () => {
    const first = workflowDefinitionId('workflow.abc123', '00000000-0000-4000-8000-000000000001')
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(workflowDefinitionId('workflow.abc123', '00000000-0000-4000-8000-000000000001')).toBe(first)
    expect(workflowDefinitionId('workflow.abc123', '00000000-0000-4000-8000-000000000002')).not.toBe(first)
  })

  test('parses YAML steps while keeping identity stable across content updates', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'deepharness-workflows-'))
    const directory = path.join(root, '.claude', 'workflows')
    const file = path.join(directory, 'release.yaml')
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(file, 'steps:\n  - name: Verify\n    prompt: Run verification\n    maxAttempts: 2\n', 'utf8')
      const first = await discoverWorkflows(root)
      expect(first).toHaveLength(1)
      expect(first[0]?.steps).toEqual([{ name: 'Verify', prompt: 'Run verification', maxAttempts: 2 }])
      await writeFile(file, 'steps:\n  - name: Publish\n    prompt: Publish artifacts\n', 'utf8')
      const second = await discoverWorkflows(root)
      expect(second[0]?.id).toBe(first[0]?.id)
      expect(second[0]?.sourceHash).not.toBe(first[0]?.sourceHash)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
