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
  vendor: string
  lock: string
  review: string
  artifacts: string
  agent: string
  previous: string | null
  writeReviewDraft: boolean
  harnessEvidence: string
}

function parseArgs(args: string[]): Options {
  const root = process.cwd()
  const options: Options = {
    vendor: resolve(root, 'vendor/claude-code'),
    lock: resolve(root, 'config/vendor-lock.json'),
    review: resolve(root, 'config/vendor-capability-review.json'),
    artifacts: resolve(root, 'artifacts/capabilities'),
    agent: '/opt/claude-code/dist/cli-bun.js',
    previous: null,
    writeReviewDraft: false,
    harnessEvidence: resolve(root, 'config/harness-capability-evidence.json'),
  }
  const valueAfter = (index: number, flag: string): string => {
    const value = args[index + 1]
    if (!value) throw new Error(`${flag} requires a value`)
    return value
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (!arg) continue
    if (arg === 'audit') continue
    if (arg === '--write-review-draft') options.writeReviewDraft = true
    else if (arg === '--vendor') options.vendor = resolve(valueAfter(index++, arg))
    else if (arg === '--lock') options.lock = resolve(valueAfter(index++, arg))
    else if (arg === '--review') options.review = resolve(valueAfter(index++, arg))
    else if (arg === '--artifacts') options.artifacts = resolve(valueAfter(index++, arg))
    else if (arg === '--agent') options.agent = resolve(valueAfter(index++, arg))
    else if (arg === '--previous') options.previous = resolve(valueAfter(index++, arg))
    else if (arg === '--harness-evidence') options.harnessEvidence = resolve(valueAfter(index++, arg))
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
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
    capability.conditions.push(
      `harness:phase-2:${entry.workflow}`,
      ...(entry.scenario ? [`fixture:${entry.scenario}`] : []),
    )
    capability.source_evidence.push({
      path: 'tests/integration/phase-2-stack.test.ts',
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

function makeManifest(options: {
  lock: VendorLock
  review: ReviewFile | null
  staticReport: StaticReport
  dynamicReport: DynamicReport
  harnessEvidence: HarnessCapabilityEvidence
  capabilities: Capability[]
}): Record<string, unknown> {
  const { lock, review, staticReport, dynamicReport, harnessEvidence, capabilities } = options
  const knownGaps = [...dynamicReport.gaps, ...harnessEvidence.known_gaps]
  const filter = (kind: Capability['kind']): Capability[] =>
    capabilities.filter(capability => capability.kind === kind)
  const unclassified = capabilities.filter(
    capability => capability.matrix_class === 'unclassified',
  )
  const classCounts: Record<string, number> = {}
  const kindCounts: Record<string, number> = {}
  for (const capability of capabilities) {
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
    build_features: filter('feature'),
    runtime_flags: filter('runtime_flag'),
    tools: filter('tool'),
    commands: filter('command'),
    agents: filter('agent'),
    acp_capabilities: filter('acp'),
    providers: filter('provider'),
    platform_integrations: filter('integration'),
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
      total: capabilities.length,
      by_kind: kindCounts,
      by_matrix_class: classCounts,
      unclassified: unclassified.length,
      unclassified_ids: unclassified.map(capability => capability.id),
      expected_failure_gaps: knownGaps.filter(
        gap => gap.status === 'expected_failure',
      ).length,
    },
    capabilities,
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
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
  const capabilities = applyHarnessEvidence(
    applyReview(discovered, review, lock.commit),
    harnessEvidence,
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
  const diff = capabilityDiff(previous, manifest)

  await Promise.all([
    writeJson(resolve(options.artifacts, 'vendor-static-audit-report.json'), staticReport),
    writeJson(resolve(options.artifacts, 'vendor-acp-probe-report.json'), dynamicReport),
    writeJson(resolve(options.artifacts, 'vendor-capability-manifest.json'), manifest),
    writeJson(resolve(options.artifacts, 'vendor-capability-diff.json'), diff),
  ])

  const summary = manifest.summary as Record<string, unknown>
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

await main()
