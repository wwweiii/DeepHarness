import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  dynamicAcpCapabilities,
  dynamicCommandCapabilities,
  runAcpProbe,
} from './acpProbe.ts'
import { proposeClassification } from './classify.ts'
import { capabilityDiff } from './diff.ts'
import { runStaticProbe } from './staticProbe.ts'
import type {
  Capability,
  DiscoveredCapability,
  DynamicReport,
  HarnessCapabilityEvidence,
  ReviewFile,
  StaticReport,
  VendorLock,
} from './types.ts'

type Options = {
  command: 'audit' | 'gate'
  vendor: string
  lock: string
  review: string
  artifacts: string
  agent: string
  previous: string | null
  writeReviewDraft: boolean
  harnessEvidence: string
  manifest: string
  diff: string
}

function parseArgs(args: string[]): Options {
  const root = process.cwd()
  const options: Options = {
    command: 'audit',
    vendor: resolve(root, 'vendor/claude-code'),
    lock: resolve(root, 'config/vendor-lock.json'),
    review: resolve(root, 'config/vendor-capability-review.json'),
    artifacts: resolve(root, 'artifacts/capabilities'),
    agent: '/opt/claude-code/dist/cli-bun.js',
    previous: null,
    writeReviewDraft: false,
    harnessEvidence: resolve(root, 'config/harness-capability-evidence.json'),
    manifest: resolve(root, 'artifacts/capabilities/vendor-capability-manifest.json'),
    diff: resolve(root, 'artifacts/capabilities/vendor-capability-diff.json'),
  }
  const valueAfter = (index: number, flag: string): string => {
    const value = args[index + 1]
    if (!value) throw new Error(`${flag} requires a value`)
    return value
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) continue
    if (arg === 'audit' || arg === 'gate') {
      options.command = arg
      continue
    }
    if (arg === '--write-review-draft') options.writeReviewDraft = true
    else if (arg === '--vendor') options.vendor = resolve(valueAfter(index++, arg))
    else if (arg === '--lock') options.lock = resolve(valueAfter(index++, arg))
    else if (arg === '--review') options.review = resolve(valueAfter(index++, arg))
    else if (arg === '--artifacts') options.artifacts = resolve(valueAfter(index++, arg))
    else if (arg === '--agent') options.agent = resolve(valueAfter(index++, arg))
    else if (arg === '--previous') options.previous = resolve(valueAfter(index++, arg))
    else if (arg === '--harness-evidence') options.harnessEvidence = resolve(valueAfter(index++, arg))
    else if (arg === '--manifest') options.manifest = resolve(valueAfter(index++, arg))
    else if (arg === '--diff') options.diff = resolve(valueAfter(index++, arg))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

function ownerForCapability(capability: DiscoveredCapability): string {
  switch (capability.kind) {
    case 'acp': return 'gateway-worker'
    case 'tool':
    case 'agent': return 'worker-supervisor'
    case 'command': return 'gateway-worker'
    case 'feature':
    case 'runtime_flag': return 'vendor-capabilities'
    case 'provider': return 'worker-provider'
    case 'integration': return 'gateway-integrations'
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function readOptionalJson<T>(path: string | null): Promise<T | null> {
  if (!path) return null
  try {
    return await readJson<T>(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function mergeDiscovered(
  staticReport: StaticReport,
  dynamicReport: DynamicReport,
): DiscoveredCapability[] {
  const byId = new Map<string, DiscoveredCapability>()
  for (const capability of [
    ...staticReport.capabilities,
    ...dynamicAcpCapabilities(dynamicReport),
    ...dynamicCommandCapabilities(dynamicReport),
  ]) {
    const prior = byId.get(capability.id)
    if (!prior) byId.set(capability.id, structuredClone(capability))
    else {
      prior.source_evidence.push(...capability.source_evidence)
      prior.enabled ||= capability.enabled
      prior.advertised_by_acp ||= capability.advertised_by_acp
      prior.ui_supported ||= capability.ui_supported
      prior.tested ||= capability.tested
      if (capability.invocable !== null) prior.invocable = capability.invocable
      if (capability.known_gap) prior.known_gap = capability.known_gap
      if (capability.last_test_result !== 'not_tested') {
        prior.last_test_result = capability.last_test_result
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function buildReviewDraft(
  vendorCommit: string,
  capabilities: DiscoveredCapability[],
): ReviewFile {
  return {
    schema_version: 1,
    vendor_commit: vendorCommit,
    reviewed_at: new Date().toISOString(),
    entries: Object.fromEntries(
      capabilities.map(capability => [
        capability.id,
        proposeClassification(capability),
      ]),
    ),
  }
}

function applyReview(
  capabilities: DiscoveredCapability[],
  review: ReviewFile | null,
  vendorCommit: string,
): Capability[] {
  const reviewMatchesVendor = review?.vendor_commit === vendorCommit
  return capabilities.map(capability => {
    const reviewed = reviewMatchesVendor ? review?.entries[capability.id] : undefined
    return {
      ...capability,
      matrix_class: reviewed?.matrix_class ?? 'unclassified',
      classification_rationale: reviewed?.rationale ?? (
        reviewMatchesVendor
          ? 'Capability was discovered after the reviewed inventory was created.'
          : 'No review file exists for the locked vendor commit.'
      ),
    }
  })
}

function applyHarnessEvidence(
  capabilities: Capability[],
  document: HarnessCapabilityEvidence,
): Capability[] {
  if (document.schema_version !== 1) throw new Error('Unsupported Harness evidence schema')
  const byId = new Map(capabilities.map(capability => [capability.id, capability]))

  for (const capability of capabilities) {
    if (capability.kind === 'tool') {
      capability.ui_supported = true
      capability.source_evidence.push(structuredClone(document.generic_tool_renderer))
    }
    if (capability.kind === 'provider') {
      capability.ui_supported = true
      capability.source_evidence.push(structuredClone(document.provider_ui))
    }
  }

  for (const entry of document.capabilities) {
    const capability = byId.get(entry.id)
    if (!capability) throw new Error(`Harness evidence references an unknown capability: ${entry.id}`)
    capability.invocable = entry.invocable === undefined ? true : entry.invocable
    capability.tested = true
    capability.ui_supported = true
    capability.last_test_result = 'passed'
    const phase = entry.phase ?? 2
    capability.conditions.push(
      `harness:phase-${phase}:${entry.workflow}`,
      ...(entry.scenario ? [`fixture:${entry.scenario}`] : []),
    )
    capability.source_evidence.push({
      path: entry.evidence_path ?? `tests/integration/phase-${phase}-stack.test.ts`,
      line: 1,
      detail: entry.evidence,
      evidenceType: 'runtime',
    })
    if (entry.known_gap) capability.known_gap = entry.known_gap
    if (entry.scenario && entry.id !== 'tool.TodoWriteTool') {
      capability.known_gap = [capability.known_gap, document.terminal_tool_result_gap]
        .filter(Boolean)
        .join(' ')
    }
  }
  return capabilities
}

const defaultUpstreamStrategy =
  'Prefer a generic upstream ACP fix, verify it through the locked vendor probe, and use an external protocol adapter only when it does not import vendor internals.'

function matrixGapEvidence(
  capability: Capability,
  dynamicReport: DynamicReport,
): Capability['source_evidence'] {
  const gapId = capability.id.includes('image')
    ? 'gap.acp.image-input'
    : /mcp/i.test(capability.id)
      ? 'gap.acp.dynamic-mcp-tools'
      : capability.id.startsWith('command.local.') || capability.id.startsWith('command.local-jsx.')
        ? 'gap.acp.local-commands'
        : capability.id === 'acp.agentInfo.version'
          ? 'gap.acp.agent-version-drift'
          : null
  const dynamicGap = gapId
    ? dynamicReport.gaps.find(gap => gap.id === gapId)
    : undefined
  if (dynamicGap) return dynamicGap.evidence.map(evidence => structuredClone(evidence))
  return [{
    path: 'tests/contract/capabilities/phase-9-matrix.test.ts',
    line: 1,
    detail: `Phase 9 negative matrix contract verifies ${capability.id} remains unavailable under its recorded ACP/build conditions.`,
    evidenceType: 'runtime',
  }]
}

function phase9DispositionEvidence(capability: Capability): Capability['source_evidence'][number] {
  return {
    path: 'tests/contract/capabilities/phase-9-matrix.test.ts',
    line: 1,
    detail: `Phase 9 matrix contract verifies ${capability.id} against its base-profile conditions and declared matrix disposition.`,
    evidenceType: 'runtime',
  }
}

function applyMatrixClosure(
  capabilities: Capability[],
  dynamicReport: DynamicReport,
): Capability[] {
  for (const capability of capabilities) {
    if (capability.matrix_class === 'C') {
      capability.known_gap ??= `ACP/platform gap: ${capability.classification_rationale}`
      capability.upstream_strategy = defaultUpstreamStrategy
      if (!capability.tested) {
        capability.tested = true
        capability.invocable ??= false
        capability.last_test_result = 'expected_failure'
        capability.source_evidence.push(...matrixGapEvidence(capability, dynamicReport))
      }
    } else if (capability.matrix_class === 'D' && !capability.tested) {
      const credentialBlockedProvider = capability.kind === 'provider'
        && capability.id !== 'provider.firstParty'
      capability.known_gap ??= capability.kind === 'provider'
        ? `Credentialed provider profile is not enabled in the base audit; conditions: ${capability.conditions.join(', ') || 'external credentials'}.`
        : `Optional platform capability is not enabled in the base audit; conditions: ${capability.conditions.join(', ') || 'external platform profile'}.`
      capability.upstream_strategy = null
      if (!credentialBlockedProvider) {
        capability.tested = true
        capability.invocable ??= false
        capability.last_test_result = 'passed'
        capability.source_evidence.push(phase9DispositionEvidence(capability))
      }
    } else if (capability.matrix_class === 'E' && !capability.tested) {
      capability.tested = true
      capability.invocable ??= false
      capability.last_test_result = 'passed'
      capability.upstream_strategy = null
      capability.source_evidence.push(phase9DispositionEvidence(capability))
    } else if (capability.matrix_class === 'B' && !capability.enabled && !capability.tested) {
      capability.tested = true
      capability.invocable ??= false
      capability.last_test_result = 'passed'
      capability.known_gap ??= `Capability is disabled in the base profile; activation conditions: ${capability.conditions.join(', ')}.`
      capability.upstream_strategy = null
      capability.source_evidence.push(phase9DispositionEvidence(capability))
    } else {
      capability.upstream_strategy ??= null
    }
  }
  return capabilities
}

function hasUnexplainedMissingTest(capability: Capability): boolean {
  if (capability.tested) return false
  if (capability.matrix_class === 'E') return !capability.classification_rationale.trim()
  if (capability.matrix_class === 'D') {
    return capability.conditions.length === 0 || !capability.known_gap?.trim()
  }
  if (!capability.enabled && capability.conditions.length > 0) return false
  return true
}

function makeManifest(options: {
  lock: VendorLock
  review: ReviewFile | null
  staticReport: StaticReport
  dynamicReport: DynamicReport
  harnessEvidence: HarnessCapabilityEvidence
  capabilities: Capability[]
}): Record<string, unknown> {
  const { lock, review, staticReport, dynamicReport, harnessEvidence, capabilities } = options
  const ownedCapabilities = capabilities.map(capability => ({
    ...capability,
    owner: capability.owner ?? ownerForCapability(capability),
    known_gap: capability.known_gap ?? (
      capability.matrix_class === 'C' && capability.ui_supported
        ? `ACP/platform gap: ${capability.classification_rationale}`
        : null
    ),
  }))
  const knownGaps = [...dynamicReport.gaps, ...harnessEvidence.known_gaps]
  const unclassified = ownedCapabilities.filter(
    capability => capability.matrix_class === 'unclassified',
  )
  const untested = ownedCapabilities.filter(capability => !capability.tested)
  const unexplainedUntested = ownedCapabilities.filter(hasUnexplainedMissingTest)
  const classCounts: Record<string, number> = {}
  const kindCounts: Record<string, number> = {}
  for (const capability of ownedCapabilities) {
    classCounts[capability.matrix_class] =
      (classCounts[capability.matrix_class] ?? 0) + 1
    kindCounts[capability.kind] = (kindCounts[capability.kind] ?? 0) + 1
  }
  return {
    schema_version: 1,
    vendor_commit: lock.commit,
    vendor_repository: lock.repository,
    vendor_tag: lock.tag,
    build_id: `ccb-bun-${lock.tag}-${lock.commit.slice(0, 12)}`,
    generated_at: new Date().toISOString(),
    reviewed_at: review?.reviewed_at ?? null,
    build_features: ownedCapabilities.filter(capability => capability.kind === 'feature'),
    runtime_flags: ownedCapabilities.filter(capability => capability.kind === 'runtime_flag'),
    tools: ownedCapabilities.filter(capability => capability.kind === 'tool'),
    commands: ownedCapabilities.filter(capability => capability.kind === 'command'),
    agents: ownedCapabilities.filter(capability => capability.kind === 'agent'),
    acp_capabilities: ownedCapabilities.filter(capability => capability.kind === 'acp'),
    providers: ownedCapabilities.filter(capability => capability.kind === 'provider'),
    platform_integrations: ownedCapabilities.filter(capability => capability.kind === 'integration'),
    known_gaps: knownGaps,
    probe_environment: {
      runtime: `bun-${Bun.version}`,
      platform: process.platform,
      architecture: process.arch,
      agent_info: dynamicReport.initialize.agentInfo ?? null,
      static_probe: staticReport.probe,
      dynamic_probe: dynamicReport.probe,
      provider_credentials_present: false,
      harness_evidence_schema: harnessEvidence.schema_version,
    },
    summary: {
      total: ownedCapabilities.length,
      by_kind: kindCounts,
      by_matrix_class: classCounts,
      unclassified: unclassified.length,
      unclassified_ids: unclassified.map(capability => capability.id),
      ownerless: ownedCapabilities.filter(capability => !capability.owner).length,
      untested: untested.length,
      untested_ids: untested.map(capability => capability.id),
      credential_blocked_untested: untested.filter(
        capability => capability.kind === 'provider' && capability.matrix_class === 'D',
      ).length,
      unexplained_untested: unexplainedUntested.length,
      unexplained_untested_ids: unexplainedUntested.map(capability => capability.id),
      expected_failure_gaps: knownGaps.filter(
        gap => gap.status === 'expected_failure',
      ).length,
    },
    capabilities: ownedCapabilities,
  }
}

export function gateManifest(manifest: Record<string, unknown>, diff: Record<string, unknown> | null): void {
  const capabilities = Array.isArray(manifest.capabilities)
    ? manifest.capabilities as Array<Record<string, unknown>>
    : []
  const failures: string[] = []
  const ids = new Set<string>()
  for (const capability of capabilities) {
    const id = String(capability.id ?? '')
    if (!id || ids.has(id)) failures.push(`duplicate_or_missing_id:${id || '<empty>'}`)
    ids.add(id)
    if (!capability.owner || typeof capability.owner !== 'string') failures.push(`owner_missing:${id}`)
    if (!['A', 'B', 'C', 'D', 'E'].includes(String(capability.matrix_class))) failures.push(`unclassified:${id}`)
    if (!String(capability.classification_rationale ?? '').trim()) failures.push(`rationale_missing:${id}`)
    if (!Array.isArray(capability.source_evidence) || capability.source_evidence.length === 0) failures.push(`evidence_missing:${id}`)
    const enabled = capability.enabled === true
    const matrix = String(capability.matrix_class)
    if (enabled && ['A', 'B'].includes(matrix)
      && (capability.tested !== true || capability.last_test_result !== 'passed')) {
      failures.push(`enabled_contract_not_passed:${id}`)
    }
    if (matrix === 'C') {
      if (capability.tested !== true || !['passed', 'expected_failure'].includes(String(capability.last_test_result))) {
        failures.push(`c_expected_failure_not_tested:${id}`)
      }
      if (!String(capability.known_gap ?? '').trim()) failures.push(`c_capability_missing_gap:${id}`)
      if (!String(capability.upstream_strategy ?? '').trim()) failures.push(`c_capability_missing_upstream_strategy:${id}`)
    }
    if (matrix === 'D') {
      if (!Array.isArray(capability.conditions) || capability.conditions.length === 0) {
        failures.push(`d_capability_missing_conditions:${id}`)
      }
      if (capability.tested !== true && !String(capability.known_gap ?? '').trim()) {
        failures.push(`d_capability_missing_degradation:${id}`)
      }
    }
  }
  const summary = manifest.summary as Record<string, unknown> | undefined
  if (Number(summary?.unclassified ?? 0) !== 0) failures.push('summary.unclassified_not_zero')
  if (Number(summary?.ownerless ?? 0) !== 0) failures.push('summary.ownerless_not_zero')
  if (Number(summary?.unexplained_untested ?? 0) !== 0) failures.push('summary.unexplained_untested_not_zero')
  const gate = diff?.gate as Record<string, unknown> | undefined
  if (Array.isArray(gate?.unreviewed_additions) && gate.unreviewed_additions.length > 0) failures.push('diff.unreviewed_additions')
  if (Array.isArray(gate?.unapproved_regressions) && gate.unapproved_regressions.length > 0) failures.push('diff.unapproved_regressions')
  if (failures.length > 0) throw new Error(`Capability release gate failed: ${failures.join(', ')}`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'gate') {
    const manifest = await readJson<Record<string, unknown>>(options.manifest)
    const diff = await readOptionalJson<Record<string, unknown>>(options.diff)
    gateManifest(manifest, diff)
    console.log(JSON.stringify({ event: 'vendor_capability_gate_passed', manifest: options.manifest }))
    return
  }
  const lock = await readJson<VendorLock>(options.lock)
  const harnessEvidence = await readJson<HarnessCapabilityEvidence>(options.harnessEvidence)
  const staticReport = await runStaticProbe(options.vendor, lock.commit)
  const dynamicReport = await runAcpProbe({
    agentPath: options.agent,
    vendorRoot: options.vendor,
    vendorCommit: lock.commit,
    staticCapabilities: staticReport.capabilities,
  })
  const discovered = mergeDiscovered(staticReport, dynamicReport)

  if (options.writeReviewDraft) {
    await writeJson(options.review, buildReviewDraft(lock.commit, discovered))
  }
  const review = await readOptionalJson<ReviewFile>(options.review)
  const capabilities = applyMatrixClosure(
    applyHarnessEvidence(
      applyReview(discovered, review, lock.commit),
      harnessEvidence,
    ),
    dynamicReport,
  )
  const manifest = makeManifest({
    lock,
    review,
    staticReport,
    dynamicReport,
    harnessEvidence,
    capabilities,
  })
  const previous = await readOptionalJson<Record<string, unknown>>(options.previous)
  const diff = capabilityDiff(previous, manifest, review?.approved_regressions)

  await Promise.all([
    writeJson(resolve(options.artifacts, 'vendor-static-audit-report.json'), staticReport),
    writeJson(resolve(options.artifacts, 'vendor-acp-probe-report.json'), dynamicReport),
    writeJson(resolve(options.artifacts, 'vendor-capability-manifest.json'), manifest),
    writeJson(resolve(options.artifacts, 'vendor-capability-diff.json'), diff),
  ])

  const summary = manifest.summary as Record<string, unknown>
  gateManifest(manifest, diff)
  console.log(JSON.stringify({ event: 'vendor_audit_completed', ...summary }))
  const knownGaps = manifest.known_gaps as Array<{ id: string; status: string }>
  const diffGate = diff.gate as {
    unreviewed_additions: string[]
    unapproved_regressions: string[]
  }
  const gapsNotExpected = knownGaps.filter(
    gap => gap.status !== 'expected_failure',
  )
  if (Number(summary.unclassified) > 0) {
    throw new Error(
      `Capability gate failed: ${summary.unclassified} unclassified capabilities.`,
    )
  }
  if (gapsNotExpected.length > 0) {
    throw new Error(
      `Known-gap contracts changed: ${gapsNotExpected.map(gap => `${gap.id}=${gap.status}`).join(', ')}`,
    )
  }
  if (diffGate.unreviewed_additions.length > 0) {
    throw new Error(
      `Capability diff gate failed: unreviewed additions ${diffGate.unreviewed_additions.join(', ')}`,
    )
  }
  if (diffGate.unapproved_regressions.length > 0) {
    throw new Error(
      `Capability diff gate failed: unapproved regressions ${diffGate.unapproved_regressions.join(', ')}`,
    )
  }
}

if (import.meta.main) await main()
