import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Evidence } from './types.ts'

export async function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

export async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = []

  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === '__tests__' ||
        entry.name === '__snapshots__'
      ) {
        continue
      }
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (/\.(?:ts|tsx|js|jsx|json)$/.test(entry.name)) result.push(child)
    }
  }

  await visit(root)
  return result.sort()
}

export function lineNumber(content: string, index: number): number {
  return content.slice(0, index).split('\n').length
}

export function sourceEvidence(
  vendorRoot: string,
  path: string,
  content: string,
  index: number,
  detail: string,
): Evidence {
  return {
    path: relative(vendorRoot, path),
    line: lineNumber(content, Math.max(index, 0)),
    detail,
    evidenceType: 'source',
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
