export type MatrixClass = 'A' | 'B' | 'C' | 'D' | 'E'

export type CapabilityKind =
  | 'tool'
  | 'feature'
  | 'command'
  | 'agent'
  | 'provider'
  | 'integration'
  | 'acp'
  | 'runtime_flag'

export type Evidence = {
  path: string
  line: number
  detail: string
  evidenceType: 'source' | 'runtime'
}

export type Capability = {
  id: string
  kind: CapabilityKind
  name: string
  matrix_class: MatrixClass | 'unclassified'
  classification_rationale: string
  compiled: boolean
  enabled: boolean
  advertised_by_acp: boolean
  invocable: boolean | null
  ui_supported: boolean
  tested: boolean
  conditions: string[]
  source_evidence: Evidence[]
  known_gap: string | null
  last_test_result: 'passed' | 'expected_failure' | 'not_tested'
}

export type DiscoveredCapability = Omit<
  Capability,
  'matrix_class' | 'classification_rationale'
>

export type ReviewEntry = {
  matrix_class: MatrixClass
  rationale: string
}

export type ReviewFile = {
  schema_version: 1
  vendor_commit: string
  reviewed_at: string
  entries: Record<string, ReviewEntry>
}

export type VendorLock = {
  repository: string
  commit: string
  tag: string
  bun_version: string
  reviewed_at: string
}

export type StaticReport = {
  schema_version: 1
  vendor_commit: string
  generated_at: string
  probe: 'static-source-audit'
  capabilities: DiscoveredCapability[]
  counts: Record<string, number>
}

export type GapResult = {
  id: string
  status: 'expected_failure' | 'unexpected_pass' | 'probe_error'
  summary: string
  evidence: Evidence[]
  upstream_strategy: string
}

export type DynamicReport = {
  schema_version: 1
  vendor_commit: string
  generated_at: string
  probe: 'ccb-bun-acp-stdio'
  command: string[]
  initialize: Record<string, unknown>
  new_session: Record<string, unknown>
  prompt: {
    response: Record<string, unknown>
    text: string
    text_updates: number
  }
  cancel: {
    response: Record<string, unknown>
    observed_stream_update: boolean
  }
  stdout_protocol_errors: string[]
  available_commands: Array<Record<string, unknown>>
  notifications_observed: number
  stderr_tail: string[]
  gaps: GapResult[]
}
