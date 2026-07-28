import type {
  HarnessEvent,
  JsonValue,
  WorkerCommand,
  WorkerToGatewayMessage,
} from '@deepharness/protocol'
import { AcpClient, type AcpUpdate } from './acp/client.ts'

type SendMessage = (message: WorkerToGatewayMessage) => void

const allowedEnvironment = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'NO_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'NODE_ENV',
] as const

function agentEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of allowedEnvironment) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function jsonPayload(value: Record<string, unknown>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

export class WorkerSupervisor {
  private client: AcpClient | null = null
  private harnessSessionId: string | null = null
  private activeTurnId: string | null = null
  private assistantStarted = false
  private terminating = false

  constructor(private readonly send: SendMessage) {}

  async handle(command: WorkerCommand): Promise<void> {
    try {
      if (command.type === 'start_session') await this.startSession(command)
      else if (command.type === 'prompt') await this.prompt(command)
      else this.cancel(command)
      this.commandResult(command, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (command.type === 'prompt') {
        this.event('turn.failed', { message }, command.payload.turnId)
      } else if (command.type === 'start_session') {
        this.event('session.status_changed', { status: 'error', message }, null)
      }
      this.commandResult(command, false, message)
    }
  }

  shutdown(): void {
    this.terminating = true
    this.client?.terminate()
  }

  private async startSession(command: Extract<WorkerCommand, { type: 'start_session' }>): Promise<void> {
    if (this.client) throw new Error('Phase 1 supports only one active Agent process')
    this.harnessSessionId = command.sessionId
    this.event('session.status_changed', { status: 'starting' }, null)
    const runtime = process.env.AGENT_RUNTIME ?? 'bun'
    const entrypoint = process.env.AGENT_ENTRYPOINT ?? '/opt/claude-code/dist/cli-bun.js'
    const client = new AcpClient({
      command: [runtime, entrypoint, '--acp'],
      cwd: command.payload.workspacePath,
      env: agentEnvironment(),
      onUpdate: update => this.handleUpdate(update),
      onProtocolError: error => {
        this.event('session.interrupted', {
          reason: 'protocol_error',
          message: error.message,
        }, this.activeTurnId)
      },
      onExit: (exitCode, stderrTail) => {
        this.client = null
        if (!this.terminating) {
          this.event('session.interrupted', {
            reason: 'agent_process_exit',
            exitCode,
            stderrTail,
          }, this.activeTurnId)
        }
      },
    })
    this.client = client
    await client.initialize()
    const session = await client.newSession(command.payload)
    const models = session.models as { currentModelId?: unknown } | undefined
    this.event('session.status_changed', {
      status: 'idle',
      agentSessionId: String(session.sessionId),
      modelId: typeof models?.currentModelId === 'string'
        ? models.currentModelId
        : command.payload.modelId,
    }, null)
  }

  private async prompt(command: Extract<WorkerCommand, { type: 'prompt' }>): Promise<void> {
    if (!this.client || this.harnessSessionId !== command.sessionId) {
      throw new Error('Agent session is not active')
    }
    this.activeTurnId = command.payload.turnId
    this.assistantStarted = false
    this.event('turn.started', {}, this.activeTurnId)
    const result = await this.client.prompt(command.payload.text, crypto.randomUUID())
    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : 'unknown'
    if (!this.assistantStarted) this.startAssistantMessage()
    this.event('assistant.message_completed', { stopReason }, this.activeTurnId)
    const usage = result.usage
    if (usage && typeof usage === 'object') {
      this.event('usage.updated', jsonPayload(usage as Record<string, unknown>), this.activeTurnId)
    }
    if (stopReason === 'cancelled') {
      this.event('session.interrupted', { reason: 'user_cancelled' }, this.activeTurnId)
    }
    this.event('turn.completed', { stopReason }, this.activeTurnId)
    this.activeTurnId = null
  }

  private cancel(command: Extract<WorkerCommand, { type: 'cancel' }>): void {
    if (this.harnessSessionId !== command.sessionId) throw new Error('Agent session is not active')
    this.client?.cancel()
  }

  private startAssistantMessage(): void {
    if (this.assistantStarted) return
    this.assistantStarted = true
    this.event('assistant.message_started', {}, this.activeTurnId)
  }

  private handleUpdate(notification: AcpUpdate): void {
    const update = notification.update
    const type = update.sessionUpdate
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const content = update.content as Record<string, unknown> | undefined
      if (content?.type !== 'text' || typeof content.text !== 'string') return
      this.startAssistantMessage()
      this.event(
        type === 'agent_message_chunk' ? 'assistant.text_delta' : 'assistant.reasoning_delta',
        { text: content.text },
        this.activeTurnId,
      )
    }
  }

  private event(
    type: HarnessEvent['type'],
    payload: Record<string, JsonValue>,
    turnId: string | null,
  ): void {
    if (!this.harnessSessionId) return
    this.send({
      kind: 'event',
      event: {
        id: crypto.randomUUID(),
        sessionId: this.harnessSessionId,
        turnId,
        type,
        payload,
        timestamp: new Date().toISOString(),
      },
    })
  }

  private commandResult(command: WorkerCommand, ok: boolean, error?: string): void {
    this.send({
      kind: 'command_result',
      commandId: command.id,
      sessionId: command.sessionId,
      ok,
      ...(error ? { error } : {}),
    })
  }
}
