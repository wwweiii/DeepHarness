import { describe, expect, test } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ARTIFACT_MAX_BYTES,
  artifactFromToolResult,
  imageArtifact,
  isArtifactTool,
  isWebTool,
  lspPayloads,
  webSourcePayload,
} from '../../apps/worker/src/artifacts.ts'

describe('phase 8 artifact and platform projections', () => {
  test('accepts a bounded workspace file and includes a deterministic digest', async () => {
    const root = `/tmp/deepharness-artifacts-${crypto.randomUUID()}`
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'report.md'), '# phase 8\n', 'utf8')
    const result = await artifactFromToolResult({
      toolName: 'artifact', toolCallId: 'tool-1',
      rawInput: { file_path: 'report.md' }, rawOutput: { file_path: 'report.md' }, workspaceRoot: root,
    })
    expect(result).toMatchObject({ status: 'ready', relativePath: 'report.md', mimeType: 'text/markdown', downloadable: true })
    expect(result?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result?.contentBase64).toBe(Buffer.from('# phase 8\n').toString('base64'))
  })

  test('rejects traversal and dangerous MIME artifacts', async () => {
    const root = `/tmp/deepharness-artifacts-${crypto.randomUUID()}`
    await mkdir(root, { recursive: true })
    const traversal = await artifactFromToolResult({
      toolName: 'artifact', toolCallId: 'tool-2', rawInput: { file_path: '../secret.sh' }, rawOutput: {}, workspaceRoot: root,
    })
    expect(traversal?.rejectionReason).toBe('ARTIFACT_PATH_OUTSIDE_WORKSPACE')
    await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\necho blocked\n', 'utf8')
    const dangerous = await artifactFromToolResult({
      toolName: 'artifact', toolCallId: 'tool-3', rawInput: { file_path: 'run.sh' }, rawOutput: { file_path: 'run.sh', mimeType: 'text/plain' }, workspaceRoot: root,
    })
    expect(dangerous?.rejectionReason).toBe('ARTIFACT_DANGEROUS_MIME')
  })

  test('recognizes runtime names and rejects symlink escape and oversized files', async () => {
    expect(isArtifactTool('artifact')).toBe(true)
    expect(isArtifactTool('ReviewArtifact')).toBe(true)
    expect(isArtifactTool('SendUserFile')).toBe(true)
    expect(isArtifactTool('Snip')).toBe(false)
    expect(isWebTool('WebFetch')).toBe(true)
    expect(isWebTool('WebSearchTool')).toBe(true)
    const root = `/tmp/deepharness-artifacts-${crypto.randomUUID()}`
    const outside = `/tmp/deepharness-artifacts-outside-${crypto.randomUUID()}`
    await mkdir(root, { recursive: true })
    await writeFile(outside, 'private', 'utf8')
    await symlink(outside, path.join(root, 'escaped.md'))
    const escaped = await artifactFromToolResult({
      toolName: 'artifact', toolCallId: 'tool-symlink', rawInput: { file_path: 'escaped.md' },
      rawOutput: null, workspaceRoot: root,
    })
    expect(escaped?.rejectionReason).toBe('ARTIFACT_SYMLINK_OUTSIDE_WORKSPACE')
    await writeFile(path.join(root, 'large.md'), Buffer.alloc(ARTIFACT_MAX_BYTES + 1))
    const oversized = await artifactFromToolResult({
      toolName: 'artifact', toolCallId: 'tool-large', rawInput: { file_path: 'large.md' },
      rawOutput: null, workspaceRoot: root,
    })
    expect(oversized?.rejectionReason).toBe('ARTIFACT_SIZE_LIMIT_EXCEEDED')
  })

  test('normalizes image, LSP, and Web source payloads without leaking arbitrary content', () => {
    const image = imageArtifact({ data: Buffer.from('png').toString('base64'), mimeType: 'image/png' })
    expect(image).toMatchObject({ status: 'ready', source: 'acp', previewable: true })
    expect(imageArtifact({ data: 'not-base64!', mimeType: 'image/png' }))
      .toMatchObject({ status: 'rejected', rejectionReason: 'ARTIFACT_INVALID_IMAGE_DATA' })
    expect(imageArtifact({ data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' }))
      .toMatchObject({ status: 'rejected', rejectionReason: 'ARTIFACT_UNSAFE_IMAGE_MIME' })
    const lsp = lspPayloads('LSP', 'tool-lsp', {
      diagnostics: [{ message: 'unused', uri: 'file:///workspace/source/a.ts', range: { start: { line: 1, character: 2 } }, severity: 'warning' }],
      locations: [{ uri: 'file:///workspace/source/a.ts', range: { start: { line: 1, character: 0 } } }],
    })
    expect(lsp.diagnostics[0]).toMatchObject({ severity: 'warning', line: 1 })
    expect(lsp.locations[0]).toMatchObject({ uri: 'file:///workspace/source/a.ts' })
    expect(webSourcePayload('WebSearch', 'tool-web', { results: [{ title: 'Example', url: 'https://example.com', snippet: 'source' }, { url: 'file:///secret' }] })).toHaveLength(1)
    expect(webSourcePayload('WebFetch', 'tool-fetch', 'Fetched https://example.com/a and https://example.com/b')).toHaveLength(2)
  })

  test('parses vendor-formatted LSP definitions and references as zero-based locations', () => {
    const definition = lspPayloads('LSP', 'tool-definition', {
      operation: 'goToDefinition',
      result: 'Defined in tests/fixtures/workspace-a/phase-eight.ts:1:14',
    }, '/workspace/source')
    expect(definition.locations[0]).toMatchObject({
      operation: 'definition', path: 'tests/fixtures/workspace-a/phase-eight.ts', line: 0, column: 13,
    })
    const references = lspPayloads('LSP', 'tool-references', {
      operation: 'findReferences',
      result: 'Found 2 references\ntests/fixtures/workspace-a/phase-eight.ts:\n  Line 1:14\n  Line 2:33',
    }, '/workspace/source')
    expect(references.locations).toHaveLength(2)
    expect(references.locations[1]).toMatchObject({ operation: 'references', line: 1, column: 32 })
  })
})
