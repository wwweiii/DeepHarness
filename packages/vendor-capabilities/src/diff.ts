import type { Capability } from './types.ts'

type ManifestLike = {
  vendor_commit?: string
  capabilities?: Capability[]
}

export function capabilityDiff(
  previous: ManifestLike | null,
  current: ManifestLike,
  approvedRegressions: Array<{
    id: string
    from: string
    to: string
  }> = [],
): Record<string, unknown> {
  const previousById = new Map(
    (previous?.capabilities ?? []).map(capability => [capability.id, capability]),
  )
  const currentById = new Map(
    (current.capabilities ?? []).map(capability => [capability.id, capability]),
  )
  const added = [...currentById.keys()].filter(id => !previousById.has(id)).sort()
  const removed = [...previousById.keys()].filter(id => !currentById.has(id)).sort()
  const changed = [...currentById.entries()]
    .flatMap(([id, capability]) => {
      const before = previousById.get(id)
      if (!before) return []
      const fields = [
        'matrix_class',
        'compiled',
        'enabled',
        'advertised_by_acp',
        'invocable',
        'ui_supported',
        'tested',
        'known_gap',
      ] as const
      const changes = fields
        .filter(field => JSON.stringify(before[field]) !== JSON.stringify(capability[field]))
        .map(field => ({ field, before: before[field], after: capability[field] }))
      return changes.length > 0 ? [{ id, changes }] : []
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  const regressions = changed.filter(item =>
    item.changes.some(change =>
      change.field === 'matrix_class' &&
      ['A', 'B'].includes(String(change.before)) &&
      ['C', 'D', 'E'].includes(String(change.after)),
    ),
  )
  const approved = (item: (typeof regressions)[number]): boolean => item.changes.some(change =>
    change.field === 'matrix_class'
      && approvedRegressions.some(approval => approval.id === item.id
        && approval.from === change.before
        && approval.to === change.after),
  )

  return {
    schema_version: 1,
    status: previous ? 'compared' : 'baseline_created',
    previous_vendor_commit: previous?.vendor_commit ?? null,
    current_vendor_commit: current.vendor_commit ?? null,
    generated_at: new Date().toISOString(),
    added,
    removed,
    changed,
    regressions,
    gate: {
      unreviewed_additions: previous
        ? added.filter(id => currentById.get(id)?.matrix_class === 'unclassified')
        : [],
      unapproved_regressions: regressions.filter(item => !approved(item)).map(item => item.id),
    },
  }
}
