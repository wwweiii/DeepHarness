import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { JsonValue } from '@deepharness/protocol'

export interface DiscoveredWorkflow {
  id: string
  name: string
  description: string
  sourcePath: string
  sourceHash: string
  steps: JsonValue[]
}

/** Stable UUID-shaped key for a workspace workflow within one Harness session. */
export function workflowDefinitionId(workflowId: string, sessionId: string): string {
  const hash = createHash('sha256').update(`${sessionId}:${workflowId}`).digest('hex').slice(0, 32)
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20)}`
}

function stepsFromText(text: string): JsonValue[] {
  const sections = text.split(/^#{1,3}\s+/m).map(value => value.trim()).filter(Boolean)
  if (sections.length <= 1) return [{ name: 'Run workflow', prompt: text.trim() }]
  return sections.map((section, index) => {
    const lines = section.split(/\r?\n/)
    const title = lines.shift()?.trim() || `Step ${index + 1}`
    return { name: title, prompt: lines.join('\n').trim() || title }
  })
}

function stepsFromStructured(value: unknown, fallbackName: string): JsonValue[] {
  const candidate = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).steps)
      ? (value as Record<string, unknown>).steps as unknown[]
      : []
  return candidate.flatMap((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return [{ name: `Step ${index + 1}`, prompt: entry.trim() }]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const step = entry as Record<string, unknown>
    const prompt = typeof step.prompt === 'string' ? step.prompt.trim() : ''
    if (!prompt) return []
    const requestedAttempts = Number(step.maxAttempts ?? 1)
    return [{
      name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : `${fallbackName} ${index + 1}`,
      prompt,
      maxAttempts: Number.isFinite(requestedAttempts) ? Math.max(1, Math.min(Math.floor(requestedAttempts), 20)) : 1,
    }]
  })
}

export async function discoverWorkflows(cwd: string): Promise<DiscoveredWorkflow[]> {
  const root = path.join(cwd, '.claude', 'workflows')
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return [] }
  const workflows: DiscoveredWorkflow[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(md|markdown|txt|yaml|yml|json)$/i.test(entry.name)) continue
    const absolute = path.join(root, entry.name)
    const text = await readFile(absolute, 'utf8')
    if (!text.trim()) continue
    const sourceHash = createHash('sha256').update(text).digest('hex')
    const sourcePath = path.relative(cwd, absolute)
    let steps: JsonValue[]
    try {
      if (/\.json$/i.test(entry.name)) {
        steps = stepsFromStructured(JSON.parse(text), 'Step')
      } else if (/\.ya?ml$/i.test(entry.name)) {
        steps = stepsFromStructured(Bun.YAML.parse(text), 'Step')
      } else steps = stepsFromText(text)
    } catch { steps = [{ name: entry.name, prompt: text }] }
    if (steps.length === 0) steps = [{ name: entry.name, prompt: text }]
    workflows.push({
      id: `workflow.${createHash('sha256').update(sourcePath).digest('hex').slice(0, 24)}`,
      name: entry.name.replace(/\.(md|markdown|txt|yaml|yml|json)$/i, ''),
      description: `Workspace workflow from ${sourcePath}`,
      sourcePath, sourceHash, steps,
    })
  }
  return workflows.sort((left, right) => left.name.localeCompare(right.name))
}
