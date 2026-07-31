import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { JsonValue } from '@deepharness/protocol'

const configuredMaxBytes = Number.parseInt(
  process.env.ARTIFACT_MAX_BYTES ?? `${10 * 1024 * 1024}`,
  10,
)

export const ARTIFACT_MAX_BYTES = Number.isFinite(configuredMaxBytes)
  ? Math.max(1_024, configuredMaxBytes)
  : 10 * 1024 * 1024

const ARTIFACT_TOOLS = new Map<string, 'file' | 'review'>([
  ['artifact', 'file'],
  ['artifacttool', 'file'],
  ['reviewartifact', 'review'],
  ['reviewartifacttool', 'review'],
  ['senduserfile', 'file'],
  ['senduserfiletool', 'file'],
])

const WEB_TOOLS = new Map<string, 'WebFetchTool' | 'WebSearchTool' | 'WebBrowserTool'>([
  ['webfetch', 'WebFetchTool'],
  ['webfetchtool', 'WebFetchTool'],
  ['websearch', 'WebSearchTool'],
  ['websearchtool', 'WebSearchTool'],
  ['webbrowser', 'WebBrowserTool'],
  ['webbrowsertool', 'WebBrowserTool'],
])

const MIME_BY_EXTENSION: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
}

const DANGEROUS_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.com',
  '.command',
  '.exe',
  '.msi',
  '.php',
  '.ps1',
  '.sh',
  '.zsh',
])

const DANGEROUS_MIME = new Set([
  'application/x-httpd-php',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-executable',
  'application/vnd.microsoft.portable-executable',
])

const SAFE_IMAGE_MIME = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

function normalizedToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isArtifactTool(name: string): boolean {
  return ARTIFACT_TOOLS.has(normalizedToolName(name))
}

export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(normalizedToolName(name))
}

function canonicalWebTool(name: string): 'WebFetchTool' | 'WebSearchTool' | 'WebBrowserTool' | null {
  return WEB_TOOLS.get(normalizedToolName(name)) ?? null
}

function artifactKind(name: string): 'file' | 'review' {
  return ARTIFACT_TOOLS.get(normalizedToolName(name)) ?? 'file'
}

export function mimeForPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function isDangerousMime(mimeType: string): boolean {
  return DANGEROUS_MIME.has(mimeType.split(';', 1)[0]!.trim().toLowerCase())
}

function isDangerousPath(filePath: string): boolean {
  return DANGEROUS_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

export function artifactPath(value: unknown, workspaceRoot: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const resolved = path.resolve(workspaceRoot, value)
  const relative = path.relative(workspaceRoot, resolved)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return resolved
}

export async function artifactFromToolResult(input: {
  toolName: string
  toolCallId: string
  rawInput: Record<string, unknown>
  rawOutput: unknown
  workspaceRoot: string
}): Promise<Record<string, JsonValue> | null> {
  if (!isArtifactTool(input.toolName)) return null
  const output = Array.isArray(input.rawOutput)
    ? Object.assign({}, ...input.rawOutput.map(objectValue))
    : objectValue(input.rawOutput)
  const candidate = firstString(
    output.file_path, output.filePath, output.path, output.filename, output.name,
    input.rawInput.file_path, input.rawInput.filePath, input.rawInput.path,
  )
  if (!candidate) return null
  const canonicalWorkspaceRoot = await realpath(input.workspaceRoot)
    .catch(() => path.resolve(input.workspaceRoot))
  const resolved = artifactPath(candidate, canonicalWorkspaceRoot)
  if (!resolved) {
    return {
      status: 'rejected',
      rejectionReason: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE',
      name: path.basename(candidate),
      relativePath: candidate,
      toolCallId: input.toolCallId,
      mimeType: 'application/octet-stream',
    }
  }
  let canonical: string
  try {
    canonical = await realpath(resolved)
  } catch {
    return {
      status: 'rejected',
      rejectionReason: 'ARTIFACT_FILE_NOT_FOUND',
      name: path.basename(candidate),
      relativePath: path.relative(canonicalWorkspaceRoot, resolved),
      toolCallId: input.toolCallId,
      mimeType: mimeForPath(resolved),
    }
  }
  const canonicalRelative = path.relative(canonicalWorkspaceRoot, canonical)
  if (canonicalRelative === '' || canonicalRelative.startsWith('..') || path.isAbsolute(canonicalRelative)) {
    return {
      status: 'rejected',
      rejectionReason: 'ARTIFACT_SYMLINK_OUTSIDE_WORKSPACE',
      name: path.basename(candidate),
      relativePath: canonicalRelative,
      toolCallId: input.toolCallId,
      mimeType: mimeForPath(canonical),
    }
  }
  const mimeType = firstString(output.mimeType, output.mime_type) ?? mimeForPath(canonical)
  if (isDangerousMime(mimeType) || isDangerousPath(canonical)) {
    return {
      status: 'rejected',
      rejectionReason: 'ARTIFACT_DANGEROUS_MIME',
      name: path.basename(canonical),
      relativePath: canonicalRelative,
      toolCallId: input.toolCallId,
      mimeType,
    }
  }

  const handle = await open(canonical, fsConstants.O_RDONLY)
  let bytes: Buffer
  let sizeBytes: number
  try {
    const information = await handle.stat()
    if (!information.isFile()) {
      return {
        status: 'rejected',
        rejectionReason: 'ARTIFACT_NOT_A_FILE',
        name: path.basename(canonical),
        relativePath: canonicalRelative,
        toolCallId: input.toolCallId,
        mimeType,
      }
    }
    if (information.size > ARTIFACT_MAX_BYTES) {
      return {
        status: 'rejected',
        rejectionReason: 'ARTIFACT_SIZE_LIMIT_EXCEEDED',
        name: path.basename(canonical),
        relativePath: canonicalRelative,
        toolCallId: input.toolCallId,
        mimeType,
        sizeBytes: information.size,
        maxBytes: ARTIFACT_MAX_BYTES,
      }
    }

    const buffer = Buffer.alloc(information.size + 1)
    let offset = 0
    while (offset < buffer.byteLength) {
      const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset !== information.size) {
      return {
        status: 'rejected',
        rejectionReason: offset > ARTIFACT_MAX_BYTES
          ? 'ARTIFACT_SIZE_LIMIT_EXCEEDED'
          : 'ARTIFACT_FILE_CHANGED_DURING_READ',
        name: path.basename(canonical),
        relativePath: canonicalRelative,
        toolCallId: input.toolCallId,
        mimeType,
        sizeBytes: offset,
        maxBytes: ARTIFACT_MAX_BYTES,
      }
    }
    bytes = buffer.subarray(0, offset)
    sizeBytes = offset
  } finally {
    await handle.close()
  }

  const normalizedMimeType = mimeType.split(';', 1)[0]!.trim().toLowerCase()
  return {
    status: 'ready',
    toolCallId: input.toolCallId,
    kind: artifactKind(input.toolName),
    name: path.basename(canonical),
    relativePath: canonicalRelative,
    storagePath: canonical,
    mimeType,
    sizeBytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
    previewable: normalizedMimeType.startsWith('text/')
      || normalizedMimeType === 'application/json'
      || normalizedMimeType === 'application/pdf'
      || SAFE_IMAGE_MIME.has(normalizedMimeType),
    downloadable: true,
    source: 'workspace',
  }
}

export function imageArtifact(input: {
  toolCallId?: string
  data: string
  mimeType: string
  name?: string
}): Record<string, JsonValue> {
  const mimeType = input.mimeType.split(';', 1)[0]!.trim().toLowerCase()
  if (!SAFE_IMAGE_MIME.has(mimeType)) {
    return {
      status: 'rejected',
      rejectionReason: 'ARTIFACT_UNSAFE_IMAGE_MIME',
      name: input.name ?? 'image-output',
      mimeType: input.mimeType,
      source: 'acp',
    }
  }
  const encoded = input.data.replace(/\s/g, '')
  const maximumEncodedLength = Math.ceil(ARTIFACT_MAX_BYTES / 3) * 4 + 4
  if (!encoded || encoded.length > maximumEncodedLength
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    return {
      status: 'rejected',
      rejectionReason: encoded.length > maximumEncodedLength
        ? 'ARTIFACT_SIZE_LIMIT_EXCEEDED'
        : 'ARTIFACT_INVALID_IMAGE_DATA',
      name: input.name ?? 'image-output',
      mimeType,
      source: 'acp',
    }
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    return {
      status: 'rejected',
      rejectionReason: 'ARTIFACT_SIZE_LIMIT_EXCEEDED',
      name: input.name ?? 'image-output',
      mimeType,
      sizeBytes: bytes.byteLength,
      maxBytes: ARTIFACT_MAX_BYTES,
      source: 'acp',
    }
  }
  return {
    status: 'ready',
    toolCallId: input.toolCallId ?? null,
    kind: 'image',
    name: input.name ?? `image-output.${mimeType.split('/')[1] ?? 'bin'}`,
    relativePath: null,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: encoded,
    previewable: true,
    downloadable: true,
    source: 'acp',
  }
}

export function webSourcePayload(
  toolName: string,
  toolCallId: string,
  rawOutput: unknown,
): Record<string, JsonValue>[] {
  const canonicalTool = canonicalWebTool(toolName)
  if (!canonicalTool) return []
  const sourceType = canonicalTool === 'WebSearchTool' ? 'search'
    : canonicalTool === 'WebBrowserTool' ? 'browser' : 'fetch'
  if (typeof rawOutput === 'string') {
    const urls = [...new Set(
      [...rawOutput.matchAll(/https?:\/\/[^\s)\]}>"']+/gi)].map(match => match[0]),
    )].slice(0, 50)
    return urls.map((url, position) => ({
      toolCallId,
      toolName: canonicalTool,
      url,
      title: url,
      snippet: rawOutput.slice(0, 500),
      sourceType,
      position,
    }))
  }
  const values = Array.isArray(rawOutput)
    ? rawOutput
    : Array.isArray(objectValue(rawOutput).results)
      ? objectValue(rawOutput).results as unknown[]
      : [rawOutput]
  return values.slice(0, 50).flatMap((value, index) => {
    const item = objectValue(value)
    const url = firstString(item.url, item.link, item.href)
    if (!url || !/^https?:\/\//i.test(url)) return []
    return [{
      toolCallId,
      toolName: canonicalTool,
      url,
      title: firstString(item.title, item.name, item.pageTitle) ?? url,
      snippet: firstString(item.snippet, item.description, item.text, item.content)?.slice(0, 500) ?? null,
      sourceType,
      position: index,
    }]
  })
}

function normalizedLspOperation(operation: string): string {
  if (operation === 'goToDefinition') return 'definition'
  if (operation === 'findReferences') return 'references'
  if (operation === 'goToImplementation') return 'implementation'
  if (operation === 'goToTypeDefinition') return 'type_definition'
  return operation
}

function lspSeverity(value: unknown): string {
  if (typeof value === 'number') {
    return ({ 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' } as Record<number, string>)[value]
      ?? 'unknown'
  }
  const severity = firstString(value)?.toLowerCase()
  return ['error', 'warning', 'information', 'hint'].includes(severity ?? '')
    ? severity!
    : 'unknown'
}

function locationUri(filePath: string, workspaceRoot?: string): string {
  if (filePath.startsWith('file://')) return filePath
  return pathToFileURL(path.resolve(workspaceRoot ?? process.cwd(), filePath)).href
}

export function lspPayloads(
  toolName: string,
  toolCallId: string,
  rawOutput: unknown,
  workspaceRoot?: string,
): {
  diagnostics: Record<string, JsonValue>[]
  locations: Record<string, JsonValue>[]
} {
  if (!['lsp', 'lsptool'].includes(normalizedToolName(toolName))) {
    return { diagnostics: [], locations: [] }
  }
  const root = objectValue(rawOutput)
  const diagnosticsValues = Array.isArray(root.diagnostics)
    ? root.diagnostics
    : Array.isArray(rawOutput) ? rawOutput : []
  const diagnostics = diagnosticsValues.flatMap(value => {
    const item = objectValue(value)
    if (typeof item.message !== 'string') return []
    const range = objectValue(item.range)
    const start = objectValue(range.start)
    const end = objectValue(range.end)
    return [{
      toolCallId,
      uri: firstString(item.uri, root.uri) ?? '',
      path: firstString(item.path, item.filePath),
      line: typeof start.line === 'number' ? start.line : typeof item.line === 'number' ? item.line : null,
      column: typeof start.character === 'number'
        ? start.character : typeof item.column === 'number' ? item.column : null,
      endLine: typeof end.line === 'number' ? end.line : null,
      endColumn: typeof end.character === 'number' ? end.character : null,
      severity: lspSeverity(item.severity),
      message: item.message,
      code: firstString(item.code),
      source: firstString(item.source),
      related: JSON.parse(JSON.stringify(
        Array.isArray(item.relatedInformation) ? item.relatedInformation : [],
      )) as JsonValue,
    }]
  })

  const operation = normalizedLspOperation(firstString(root.operation, root.action) ?? 'unknown')
  const locationValues = Array.isArray(root.locations)
    ? root.locations
    : Array.isArray(root.result) ? root.result
      : Array.isArray(rawOutput) ? rawOutput : []
  const locations: Record<string, JsonValue>[] = locationValues.flatMap(value => {
    const item = objectValue(value)
    const uri = firstString(item.uri, item.targetUri)
    if (!uri) return []
    const range = objectValue(item.range ?? item.targetSelectionRange)
    const start = objectValue(range.start)
    const end = objectValue(range.end)
    return [{
      toolCallId,
      operation,
      uri,
      path: firstString(item.path, item.filePath),
      line: typeof start.line === 'number' ? start.line : null,
      column: typeof start.character === 'number' ? start.character : null,
      endLine: typeof end.line === 'number' ? end.line : null,
      endColumn: typeof end.character === 'number' ? end.character : null,
      preview: firstString(item.preview, item.name),
      metadata: JSON.parse(JSON.stringify(item)) as JsonValue,
    }]
  })

  const resultText = firstString(root.result)
  if (locations.length === 0 && resultText) {
    let groupedPath: string | null = null
    for (const line of resultText.split('\n')) {
      const trimmed = line.trim()
      const direct = trimmed.match(/^(?:Defined in\s+)?(.+):(\d+):(\d+)$/)
      if (direct && !trimmed.startsWith('Found ')) {
        const filePath = direct[1]!
        locations.push({
          toolCallId,
          operation,
          uri: locationUri(filePath, workspaceRoot),
          path: filePath,
          line: Number.parseInt(direct[2]!, 10) - 1,
          column: Number.parseInt(direct[3]!, 10) - 1,
          endLine: null,
          endColumn: null,
          preview: null,
          metadata: { source: 'vendor_formatted_result' },
        })
        continue
      }
      const header = trimmed.match(/^(.+):$/)
      if (header && !trimmed.startsWith('Found ')) {
        groupedPath = header[1]!
        continue
      }
      const grouped = trimmed.match(/^Line\s+(\d+):(\d+)$/)
      if (grouped && groupedPath) {
        locations.push({
          toolCallId,
          operation,
          uri: locationUri(groupedPath, workspaceRoot),
          path: groupedPath,
          line: Number.parseInt(grouped[1]!, 10) - 1,
          column: Number.parseInt(grouped[2]!, 10) - 1,
          endLine: null,
          endColumn: null,
          preview: null,
          metadata: { source: 'vendor_formatted_result' },
        })
      }
    }
  }
  return { diagnostics, locations }
}
