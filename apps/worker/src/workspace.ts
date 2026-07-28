import type { WorkspaceMode } from '@deepharness/protocol'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

export interface PreparedWorkspace {
  cwd: string
  sourcePath: string
  mode: WorkspaceMode
  worktreePath: string | null
  branch: string | null
}

function roots(): string[] {
  return (process.env.WORKSPACE_ROOTS ?? '/workspace/source')
    .split(',')
    .map(value => path.resolve(value.trim()))
    .filter(Boolean)
}

function runsRoot(): string {
  return path.resolve(process.env.WORKTREE_RUNS_ROOT ?? '/workspace/runs')
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function validateWorkspacePath(value: string): string {
  const resolved = path.resolve(value)
  if (!path.isAbsolute(value) || !roots().some(root => inside(resolved, root))) {
    throw new Error(`WORKSPACE_PATH_OUTSIDE_ALLOWED_ROOTS:${value}`)
  }
  return resolved
}

async function exists(value: string): Promise<boolean> {
  try {
    await stat(value)
    return true
  } catch {
    return false
  }
}

async function git(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  const process = Bun.spawn(['git', '-c', 'safe.directory=*', ...args], {
    cwd,
    env: { PATH: processEnv('PATH'), HOME: processEnv('HOME') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => process.kill('SIGKILL'), timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  clearTimeout(timer)
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${exitCode}`}`)
  }
  return stdout.trim()
}

function processEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for workspace management`)
  return value
}

export async function prepareWorkspace(input: {
  sessionId: string
  workspacePath: string
  workspaceMode: WorkspaceMode
}): Promise<PreparedWorkspace> {
  const sourcePath = validateWorkspacePath(input.workspacePath)
  if (input.workspaceMode === 'shared') {
    return { cwd: sourcePath, sourcePath, mode: 'shared', worktreePath: null, branch: null }
  }

  const repoRoot = path.resolve(await git(['rev-parse', '--show-toplevel'], sourcePath))
  if (!inside(sourcePath, repoRoot)) throw new Error('WORKTREE_SOURCE_IS_NOT_GIT_REPOSITORY')
  const target = path.join(runsRoot(), input.sessionId)
  if (!inside(target, runsRoot())) throw new Error('WORKTREE_PATH_OUTSIDE_RUNS_ROOT')
  const branch = `deepharness/${input.sessionId}`
  await mkdir(runsRoot(), { recursive: true })
  await git(['worktree', 'prune'], repoRoot)

  if (await exists(target)) {
    const entries = await readdir(target)
    if (entries.length > 0) {
      try {
        await git(['rev-parse', '--is-inside-work-tree'], target)
        return { cwd: target, sourcePath: repoRoot, mode: 'worktree', worktreePath: target, branch }
      } catch {
        throw new Error(`WORKTREE_RECOVERY_REQUIRED:${target}`)
      }
    }
    await rm(target, { recursive: true })
  }

  try {
    await git(['worktree', 'add', '-b', branch, target, 'HEAD'], repoRoot, 60_000)
  } catch (error) {
    if (!String(error).includes('already exists')) throw error
    await git(['worktree', 'add', target, branch], repoRoot, 60_000)
  }
  return { cwd: target, sourcePath: repoRoot, mode: 'worktree', worktreePath: target, branch }
}

export async function cleanupWorkspace(
  prepared: PreparedWorkspace,
  removeCleanWorktree: boolean,
): Promise<{ removed: boolean; dirty: boolean }> {
  if (prepared.mode !== 'worktree' || !prepared.worktreePath) {
    return { removed: false, dirty: false }
  }
  if (!await exists(prepared.worktreePath)) return { removed: true, dirty: false }
  const dirty = (await git(['status', '--porcelain'], prepared.worktreePath)).length > 0
  if (dirty || !removeCleanWorktree) return { removed: false, dirty }
  await git(['worktree', 'remove', prepared.worktreePath], prepared.sourcePath, 60_000)
  if (prepared.branch) {
    try {
      await git(['branch', '-D', prepared.branch], prepared.sourcePath)
    } catch {
      // The worktree is already detached from the branch; pruning is sufficient.
    }
  }
  await git(['worktree', 'prune'], prepared.sourcePath)
  return { removed: true, dirty: false }
}

export async function cleanupAbandonedWorktreeStaging(): Promise<number> {
  const root = runsRoot()
  if (!await exists(root)) return 0
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.creating-')) continue
    const target = path.join(root, entry.name)
    if (!inside(target, root)) continue
    await rm(target, { recursive: true })
    removed += 1
  }
  return removed
}
