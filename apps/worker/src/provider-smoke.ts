import { stat } from 'node:fs/promises'
import { AcpClient } from './acp/client.ts'
import {
  activeProviderStatus,
  agentEnvironment,
  PROVIDER_IDS,
  providerCredentialAlternatives,
  type ProviderId,
} from './provider.ts'

const expected = process.env.PROVIDER_SMOKE_ID
if (!PROVIDER_IDS.includes(expected as ProviderId)) {
  throw new Error(`PROVIDER_SMOKE_ID must be one of: ${PROVIDER_IDS.join(', ')}`)
}
const providerId = expected as ProviderId
const status = activeProviderStatus()
if (status.providerId !== providerId) {
  throw new Error(`Provider selector resolved to ${status.providerId}, expected ${providerId}`)
}
if (status.credentialStatus !== 'configured') {
  const alternatives = providerCredentialAlternatives[providerId]
    .map(names => names.join(' + '))
    .join(' OR ')
  throw new Error(`Provider ${providerId} credentials are missing; expected ${alternatives}`)
}
if (providerId === 'vertex') {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS!
  const credentialFile = await stat(credentialPath).catch(() => null)
  if (!credentialFile?.isFile() || credentialFile.size === 0) {
    throw new Error(`Vertex credential file is missing or empty: ${credentialPath}`)
  }
}

const workspacePath = process.env.WORKSPACE_PATH ?? '/workspace/source'
const timeoutMs = Math.max(1_000, Number.parseInt(
  process.env.PROVIDER_SMOKE_TIMEOUT_MS ?? '120000',
  10,
))
const expectedText = 'DEEPHARNESS_PROVIDER_SMOKE_OK'
let responseText = ''
let client: AcpClient | null = null
let exitedResolve: (() => void) | null = null
let protocolReject: ((error: Error) => void) | null = null
let timeoutHandle: ReturnType<typeof setTimeout> | null = null
const exited = new Promise<void>(resolve => { exitedResolve = resolve })
const protocolFailure = new Promise<never>((_, reject) => { protocolReject = reject })

try {
  client = new AcpClient({
    command: [
      process.env.AGENT_RUNTIME ?? 'bun',
      process.env.AGENT_ENTRYPOINT ?? '/opt/claude-code/dist/cli-bun.js',
      '--acp',
    ],
    cwd: workspacePath,
    env: agentEnvironment(),
    onUpdate(update) {
      if (update.update.sessionUpdate !== 'agent_message_chunk') return
      const content = update.update.content
      if (content && typeof content === 'object' && 'text' in content) {
        responseText += String((content as Record<string, unknown>).text ?? '')
      }
    },
    onClientRequest(request) {
      client?.reject(request.id, -32601, 'Provider smoke does not permit client-side tools')
    },
    onProtocolError(error) {
      protocolReject?.(error)
    },
    onExit() {
      exitedResolve?.()
    },
  })

  const smoke = (async () => {
    await client!.initialize()
    const session = await client!.newSession({ permissionMode: 'default', modelId: null })
    const result = await client!.prompt(
      `Reply with exactly ${expectedText}. Do not use tools or add any other text.`,
      crypto.randomUUID(),
    )
    if (result.stopReason !== 'end_turn') {
      throw new Error(`Provider smoke stopped with ${String(result.stopReason)}`)
    }
    if (responseText.trim() !== expectedText) {
      throw new Error(`Provider smoke returned an unexpected response (${responseText.length} characters)`)
    }
    return { sessionId: String(session.sessionId), usage: result.usage ?? null }
  })()
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Provider smoke timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  const result = await Promise.race([smoke, timeout, protocolFailure])
  console.log(JSON.stringify({
    event: 'provider_smoke_passed',
    providerId,
    requestCount: 1,
    stopReason: 'end_turn',
    sessionIdPresent: Boolean(result.sessionId),
    usage: result.usage,
  }))
} finally {
  if (timeoutHandle) clearTimeout(timeoutHandle)
  client?.terminate()
  await Promise.race([exited, Bun.sleep(5_000)])
}
