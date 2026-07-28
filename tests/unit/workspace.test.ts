import { describe, expect, test } from 'bun:test'
import { validateWorkspacePath } from '../../apps/worker/src/workspace.ts'

describe('workspace path boundary', () => {
  test('allows configured roots and rejects traversal and unrelated absolute paths', () => {
    expect(validateWorkspacePath('/workspace/source/project')).toBe('/workspace/source/project')
    expect(() => validateWorkspacePath('/workspace/source/../secret')).toThrow(
      'WORKSPACE_PATH_OUTSIDE_ALLOWED_ROOTS',
    )
    expect(() => validateWorkspacePath('/tmp/project')).toThrow(
      'WORKSPACE_PATH_OUTSIDE_ALLOWED_ROOTS',
    )
    expect(() => validateWorkspacePath('relative/project')).toThrow(
      'WORKSPACE_PATH_OUTSIDE_ALLOWED_ROOTS',
    )
  })
})
