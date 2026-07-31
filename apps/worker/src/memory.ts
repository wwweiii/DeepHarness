import type { JsonValue } from '@deepharness/protocol'

const localMemoryNames = new Set(['LocalMemoryRecall', 'LocalMemoryRecallTool'])
const vaultMemoryNames = new Set(['VaultHttpFetch', 'VaultHttpFetchTool'])
const deferredToolNames = new Set(['ExecuteExtraTool', 'ExecuteTool'])

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function endpointLabel(value: unknown): string {
  if (typeof value !== 'string') return 'HTTPS endpoint'
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return 'Invalid HTTPS endpoint'
  }
}

export function isMemoryTool(toolName: string): boolean {
  return localMemoryNames.has(toolName) || vaultMemoryNames.has(toolName)
}

export function safePermissionMemoryInput(
  toolName: string,
  input: Record<string, JsonValue>,
): { toolName: string; input: Record<string, JsonValue> } | null {
  const effectiveName = isMemoryTool(toolName)
    ? toolName
    : deferredToolNames.has(toolName) && typeof input.tool_name === 'string'
      && isMemoryTool(input.tool_name)
      ? input.tool_name
      : null
  if (!effectiveName) return null
  const params = deferredToolNames.has(toolName) ? objectValue(input.params) : input
  return {
    toolName: effectiveName,
    input: safeMemoryInput(effectiveName, params as Record<string, JsonValue>),
  }
}

export function safeMemoryInput(
  toolName: string,
  input: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (localMemoryNames.has(toolName)) {
    return {
      action: typeof input.action === 'string' ? input.action : 'unknown',
      store: typeof input.store === 'string' ? input.store : null,
      key: typeof input.key === 'string' ? input.key : null,
      previewOnly: typeof input.previewOnly === 'boolean'
        ? input.previewOnly
        : input.preview_only !== false,
      contentRedacted: true,
    }
  }
  return {
    method: typeof input.method === 'string' ? input.method : 'GET',
    endpoint: endpointLabel(input.endpoint ?? input.url),
    vaultKeyFingerprint: typeof input.vaultKeyFingerprint === 'string'
      ? input.vaultKeyFingerprint
      : typeof input.vault_auth_key === 'string'
        ? fingerprint(input.vault_auth_key)
        : null,
    contentRedacted: true,
  }
}

export interface MemoryResultSummary {
  hit: boolean | null
  itemCount: number | null
  bytes: number | null
  truncated: boolean
  errorCode: string | null
  httpStatus: number | null
  contentRedacted: true
}

function errorCode(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const normalized = value.toLowerCase()
  if (normalized.includes('not found')) return 'not_found'
  if (normalized.includes('budget') && normalized.includes('exceed')) return 'budget_exceeded'
  if (normalized.includes('vault') || normalized.includes('secret')) return 'vault_unavailable'
  if (normalized.includes('timeout')) return 'timeout'
  if (normalized.includes('permission') || normalized.includes('denied')) return 'permission_denied'
  return 'tool_error'
}

export function summarizeMemoryResult(output: JsonValue | undefined): MemoryResultSummary {
  const outer = objectValue(output)
  const nestedData = objectValue(outer.data)
  const nestedResult = objectValue(outer.result)
  const data = Object.keys(nestedData).length > 0
    ? nestedData
    : Object.keys(nestedResult).length > 0
      ? nestedResult
      : outer
  const value = typeof data.value === 'string'
    ? data.value
    : typeof data.body === 'string'
      ? data.body
      : null
  const stores = Array.isArray(data.stores) ? data.stores : null
  const entries = Array.isArray(data.entries) ? data.entries : null
  const detectedError = errorCode(data.error)
    ?? (typeof output === 'string' ? errorCode(output) : null)
  const status = finiteNumber(data.status)
  const itemCount = stores?.length ?? entries?.length ?? null
  const budgetExceeded = data.budget_exceeded === true
  return {
    hit: value !== null
      ? detectedError === null && !budgetExceeded
      : itemCount !== null
        ? itemCount > 0
        : detectedError || budgetExceeded
          ? false
          : null,
    itemCount,
    bytes: value === null ? null : Buffer.byteLength(value, 'utf8'),
    truncated: data.truncated === true,
    errorCode: detectedError
      ?? (budgetExceeded ? 'budget_exceeded' : null)
      ?? (status !== null && status >= 400 ? `http_${status}` : null),
    httpStatus: status,
    contentRedacted: true,
  }
}

export function memoryObservationPayload(input: {
  toolName: string
  toolCallId: string
  status: string
  rawInput: Record<string, JsonValue>
  rawOutput?: JsonValue
}): Record<string, JsonValue> {
  const safeInput = safeMemoryInput(input.toolName, input.rawInput)
  const result = summarizeMemoryResult(input.rawOutput)
  const local = localMemoryNames.has(input.toolName)
  const sourceLabel = local
    ? [safeInput.store, safeInput.key].filter(value => typeof value === 'string').join('/') || 'Local memory'
    : String(safeInput.endpoint ?? 'HTTPS endpoint')
  return {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    sourceType: local ? 'local_memory' : 'vault_http',
    sourceLabel,
    operation: String(safeInput.action ?? safeInput.method ?? 'unknown'),
    status: input.status,
    hit: result.hit,
    itemCount: result.itemCount,
    bytes: result.bytes,
    truncated: result.truncated,
    errorCode: result.errorCode,
    httpStatus: result.httpStatus,
    contentRedacted: true,
  }
}
