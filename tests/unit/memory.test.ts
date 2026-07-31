import { describe, expect, test } from 'bun:test'
import {
  memoryObservationPayload,
  safeMemoryInput,
  safePermissionMemoryInput,
  summarizeMemoryResult,
} from '../../apps/worker/src/memory.ts'

describe('Memory control-plane redaction', () => {
  test('retains Local Memory provenance while removing result content', () => {
    const input = safeMemoryInput('LocalMemoryRecall', {
      action: 'fetch',
      store: 'project',
      key: 'preferences',
      preview_only: false,
    })
    const observation = memoryObservationPayload({
      toolName: 'LocalMemoryRecall',
      toolCallId: 'memory-local-1',
      status: 'completed',
      rawInput: input,
      rawOutput: {
        action: 'fetch',
        value: 'private memory content',
        truncated: true,
      },
    })

    expect(input).toEqual({
      action: 'fetch',
      store: 'project',
      key: 'preferences',
      previewOnly: false,
      contentRedacted: true,
    })
    expect(observation).toMatchObject({
      sourceType: 'local_memory',
      sourceLabel: 'project/preferences',
      operation: 'fetch',
      hit: true,
      bytes: Buffer.byteLength('private memory content', 'utf8'),
      truncated: true,
      contentRedacted: true,
    })
    expect(JSON.stringify(observation)).not.toContain('private memory content')
  })

  test('unwraps deferred Memory results persisted by the vendor transcript', () => {
    const privateContent = 'private deferred memory content'
    const summary = summarizeMemoryResult({
      tool_name: 'LocalMemoryRecall',
      result: {
        action: 'fetch',
        store: 'project',
        key: 'preferences',
        value: privateContent,
        preview_only: true,
      },
    })

    expect(summary).toMatchObject({
      hit: true,
      bytes: Buffer.byteLength(privateContent, 'utf8'),
      contentRedacted: true,
    })
    expect(JSON.stringify(summary)).not.toContain(privateContent)
  })

  test('strips Vault secrets, request bodies, reasons, query strings, and response bodies', () => {
    const input = safeMemoryInput('VaultHttpFetchTool', {
      url: 'https://api.example.test/private/items?token=query-secret#fragment',
      method: 'POST',
      vault_auth_key: 'github-personal-prod',
      auth_scheme: 'bearer',
      body: '{"secret":"request-secret"}',
      reason: 'private reason',
    })
    const summary = summarizeMemoryResult({
      status: 200,
      body: 'private response body',
      responseHeaders: { authorization: 'response-secret' },
    })
    const observation = memoryObservationPayload({
      toolName: 'VaultHttpFetchTool',
      toolCallId: 'memory-vault-1',
      status: 'completed',
      rawInput: input,
      rawOutput: {
        status: 200,
        body: 'private response body',
        responseHeaders: { authorization: 'response-secret' },
      },
    })
    const serialized = JSON.stringify({ input, summary, observation })

    expect(input).toMatchObject({
      endpoint: 'https://api.example.test/private/items',
      method: 'POST',
      contentRedacted: true,
    })
    expect(input.vaultKeyFingerprint).toMatch(/^[a-f0-9]{8}$/)
    expect(summary).toMatchObject({
      hit: true,
      bytes: Buffer.byteLength('private response body', 'utf8'),
      httpStatus: 200,
      contentRedacted: true,
    })
    for (const secret of [
      'query-secret',
      'fragment',
      'github-personal-prod',
      'request-secret',
      'private reason',
      'private response body',
      'response-secret',
    ]) expect(serialized).not.toContain(secret)
  })

  test('recognizes and redacts deferred Memory permission wrappers', () => {
    const permission = safePermissionMemoryInput('ExecuteExtraTool', {
      tool_name: 'VaultHttpFetch',
      params: {
        url: 'https://api.example.test/private?token=permission-secret',
        method: 'POST',
        vault_auth_key: 'private-vault-key-name',
        body: 'private request body',
        reason: 'private permission reason',
      },
    })
    expect(permission).toMatchObject({
      toolName: 'VaultHttpFetch',
      input: {
        endpoint: 'https://api.example.test/private',
        method: 'POST',
        contentRedacted: true,
      },
    })
    const serialized = JSON.stringify(permission)
    for (const secret of [
      'permission-secret',
      'private-vault-key-name',
      'private request body',
      'private permission reason',
    ]) expect(serialized).not.toContain(secret)
  })

  test('reports misses and budget failures without retaining error text', () => {
    expect(summarizeMemoryResult({ stores: [] })).toMatchObject({
      hit: false,
      itemCount: 0,
    })
    const summary = summarizeMemoryResult({
      budget_exceeded: true,
      error: 'budget exceeded while fetching private-memory-key',
    })
    expect(summary).toMatchObject({
      hit: false,
      errorCode: 'budget_exceeded',
      contentRedacted: true,
    })
    expect(JSON.stringify(summary)).not.toContain('private-memory-key')
  })
})
