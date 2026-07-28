import type {
  HarnessEvent,
  JsonValue,
  PermissionOption,
  WorkerCommand,
  WorkerToGatewayMessage,
} from '@deepharness/protocol'
import {
  AcpClient,
  type AcpClientRequest,
  type AcpUpdate,
} from './acp/client.ts'
import { activeProviderStatus, agentEnvironment } from './provider.ts'

type SendMessage = (message: WorkerToGatewayMessage) => void
type PromptCommand = Extract<WorkerCommand, { type: 'prompt' }>

interface PendingPermission {
  permissionRequestId: string
  rpcId: number | string
  turnId: string | null
  toolCallId: string
  toolName: string
  input: Record<string, JsonValue>
  options: PermissionOption[]
  question: boolean
  expiresAt: string
  timer: ReturnType<typeof setTimeout>
}

interface OpenToolCall {
  turnId: string | null
  payload: Record<string, JsonValue>
}

const missingTerminalToolResult =
  'Vendor ACP ended the turn without forwarding the terminal tool_result update; raw output is unavailable.'

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue
}

function jsonPayload(value: Record<string, unknown>): Record<string, JsonValue> {
  return jsonValue(value) as Record<string, JsonValue>
}

function objectValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? jsonPayload(value as Record<string, unknown>)
    : {}
}

function questionContinuation(answers: Record<string, string>): string {
  const lines = Object.entries(answers).map(([question, answer]) => `- ${question}: ${answer}`)
  return [
    'The user answered the preceding AskUserQuestion request through DeepHarness:',
    ...lines,
    'Continue the task using these answers.',
  ].join('\n')
}

export class WorkerSupervisor {
  private client: AcpClient | null = null
  private harnessSessionId: string | null = null
  private activeTurnId: string | null = null
  private assistantStarted = false
  private terminating = false
  private drainingPrompts = false
  private readonly promptQueue: PromptCommand[] = []
  private readonly toolNames = new Map<string, string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly questionContinuations: string[] = []
  private readonly openToolCalls = new Map<string, OpenToolCall>()
  private readonly deniedToolCalls = new Set<string>()

  constructor(private readonly send: SendMessage) {}

  async handle(command: WorkerCommand): Promise<void> {
    try {
      if (command.type === 'start_session') await this.startSession(command)
      else if (command.type === 'prompt') this.enqueuePrompt(command)
      else if (command.type === 'cancel') this.cancel(command)
      else if (command.type === 'resolve_permission') this.resolvePermission(command)
      else if (command.type === 'set_mode') await this.setMode(command)
      else await this.setModel(command)
      this.commandResult(command, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (command.type === 'start_session') {
        this.event('session.status_changed', { status: 'error', message }, null)
      }
      this.commandResult(command, false, message)
    }
  }

  shutdown(): void {
    this.terminating = true
    for (const pending of this.pendingPermissions.values()) clearTimeout(pending.timer)
    this.pendingPermissions.clear()
    this.client?.terminate()
  }

  private async startSession(command: Extract<WorkerCommand, { type: 'start_session' }>): Promise<void> {
    if (this.client) throw new Error('Only one active Agent process is supported by this Worker')
    this.harnessSessionId = command.sessionId
    this.event('session.status_changed', { status: 'starting' }, null)
    const runtime = process.env.AGENT_RUNTIME ?? 'bun'
    const entrypoint = process.env.AGENT_ENTRYPOINT ?? '/opt/claude-code/dist/cli-bun.js'
    const client = new AcpClient({
      command: [runtime, entrypoint, '--acp'],
      cwd: command.payload.workspacePath,
      env: agentEnvironment(),
      onUpdate: update => this.handleUpdate(update),
      onClientRequest: request => this.handleClientRequest(request),
      onProtocolError: error => {
        this.event('session.interrupted', {
          reason: 'protocol_error',
          message: error.message,
        }, this.activeTurnId)
      },
      onExit: (exitCode, stderrTail) => {
        this.client = null
        for (const pending of [...this.pendingPermissions.values()]) {
          this.finishPermission(pending, 'expired', 'agent_process_exit')
        }
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
    const initialize = await client.initialize()
    const session = await client.newSession(command.payload)
    const models = objectValue(session.models)
    const modes = objectValue(session.modes)
    this.event('session.status_changed', {
      status: 'idle',
      agentSessionId: String(session.sessionId),
      providerId: activeProviderStatus().providerId,
      modelId: command.payload.modelId
        ?? (typeof models.currentModelId === 'string' ? models.currentModelId : null),
      permissionMode: typeof modes.currentModeId === 'string'
        ? modes.currentModeId
        : command.payload.permissionMode,
      availableModels: jsonValue(models.availableModels ?? []),
      availableModes: jsonValue(modes.availableModes ?? []),
      configOptions: jsonValue(session.configOptions ?? []),
      agentCapabilities: jsonValue(initialize.agentCapabilities ?? {}),
    }, null)
  }

  private enqueuePrompt(command: PromptCommand): void {
    if (!this.client || this.harnessSessionId !== command.sessionId) {
      throw new Error('Agent session is not active')
    }
    this.promptQueue.push(command)
    this.emitQueue()
    void this.drainPromptQueue()
  }

  private async drainPromptQueue(): Promise<void> {
    if (this.drainingPrompts) return
    this.drainingPrompts = true
    try {
      while (this.promptQueue.length > 0) {
        const command = this.promptQueue.shift()
        if (!command) continue
        this.emitQueue()
        try {
          await this.runPrompt(command)
        } catch (error) {
          this.event('turn.failed', {
            message: error instanceof Error ? error.message : String(error),
          }, command.payload.turnId)
        } finally {
          this.activeTurnId = null
          this.questionContinuations.length = 0
        }
      }
    } finally {
      this.drainingPrompts = false
      this.emitQueue()
    }
  }

  private async runPrompt(command: PromptCommand): Promise<void> {
    if (!this.client) throw new Error('Agent session is not active')
    this.activeTurnId = command.payload.turnId
    this.assistantStarted = false
    this.event('turn.started', {}, this.activeTurnId)

    let promptText = command.payload.text
    let result: Record<string, unknown> = {}
    do {
      result = await this.client.prompt(promptText, crypto.randomUUID())
      this.finishOpenToolCalls()
      const usage = result.usage
      if (usage && typeof usage === 'object') {
        this.event('usage.updated', jsonPayload(usage as Record<string, unknown>), this.activeTurnId)
      }
      const continuation = this.questionContinuations.shift()
      if (!continuation || result.stopReason === 'cancelled') break
      promptText = continuation
    } while (true)

    const stopReason = typeof result.stopReason === 'string' ? result.stopReason : 'unknown'
    if (!this.assistantStarted) this.startAssistantMessage()
    this.event('assistant.message_completed', { stopReason }, this.activeTurnId)
    if (stopReason === 'cancelled') {
      this.event('session.interrupted', { reason: 'user_cancelled' }, this.activeTurnId)
    }
    this.event('turn.completed', { stopReason }, this.activeTurnId)
  }

  private cancel(command: Extract<WorkerCommand, { type: 'cancel' }>): void {
    if (this.harnessSessionId !== command.sessionId || !this.activeTurnId) {
      throw new Error('Agent session is not running')
    }
    this.client?.cancel()
  }

  private async setMode(command: Extract<WorkerCommand, { type: 'set_mode' }>): Promise<void> {
    if (!this.client || this.harnessSessionId !== command.sessionId) {
      throw new Error('Agent session is not active')
    }
    await this.client.setMode(command.payload.modeId)
    this.event('session.configuration_changed', {
      permissionMode: command.payload.modeId,
    }, null)
  }

  private async setModel(command: Extract<WorkerCommand, { type: 'set_model' }>): Promise<void> {
    if (!this.client || this.harnessSessionId !== command.sessionId) {
      throw new Error('Agent session is not active')
    }
    await this.client.setModel(command.payload.modelId)
    this.event('session.configuration_changed', {
      modelId: command.payload.modelId,
    }, null)
  }

  private resolvePermission(
    command: Extract<WorkerCommand, { type: 'resolve_permission' }>,
  ): void {
    if (!this.client || this.harnessSessionId !== command.sessionId) {
      throw new Error('Agent session is not active')
    }
    const pending = this.pendingPermissions.get(command.payload.permissionRequestId)
    if (!pending) throw new Error('Permission request is no longer pending')
    if (!pending.options.some(option => option.optionId === command.payload.optionId)) {
      throw new Error('Permission option was not offered by the Agent')
    }
    if (command.payload.answers && Object.keys(command.payload.answers).length > 0) {
      this.questionContinuations.push(questionContinuation(command.payload.answers))
    }
    this.client.respond(pending.rpcId, {
      outcome: { outcome: 'selected', optionId: command.payload.optionId },
    })
    const status = command.payload.optionId.startsWith('reject') ? 'denied' : 'approved'
    this.finishPermission(pending, status, command.payload.optionId, command.payload.answers)
  }

  private handleClientRequest(request: AcpClientRequest): void {
    if (request.method !== 'session/request_permission') {
      this.client?.reject(request.id, -32601, `Unsupported client method: ${request.method}`)
      return
    }
    const toolCall = objectValue(request.params.toolCall)
    const toolCallId = typeof toolCall.toolCallId === 'string'
      ? toolCall.toolCallId
      : crypto.randomUUID()
    const toolName = this.toolNames.get(toolCallId)
      ?? (typeof toolCall.title === 'string' ? toolCall.title : 'UnknownTool')
    const options = Array.isArray(request.params.options)
      ? request.params.options.flatMap(value => {
          const option = objectValue(value)
          return typeof option.optionId === 'string'
            ? [{
                optionId: option.optionId,
                kind: typeof option.kind === 'string' ? option.kind : 'unknown',
                name: typeof option.name === 'string' ? option.name : option.optionId,
              }]
            : []
        })
      : []
    const permissionRequestId = crypto.randomUUID()
    const timeoutMs = Math.max(250, Number.parseInt(
      process.env.PERMISSION_REQUEST_TIMEOUT_MS ?? '120000',
      10,
    ))
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString()
    const pending: PendingPermission = {
      permissionRequestId,
      rpcId: request.id,
      turnId: this.activeTurnId,
      toolCallId,
      toolName,
      input: objectValue(toolCall.rawInput),
      options,
      question: /AskUserQuestion/i.test(toolName),
      expiresAt,
      timer: setTimeout(() => {
        const current = this.pendingPermissions.get(permissionRequestId)
        if (!current) return
        this.client?.respond(current.rpcId, {
          outcome: { outcome: 'selected', optionId: 'reject' },
        })
        this.finishPermission(current, 'expired', 'reject')
      }, timeoutMs),
    }
    this.pendingPermissions.set(permissionRequestId, pending)
    const payload: Record<string, JsonValue> = {
      permissionRequestId,
      acpRequestId: String(request.id),
      toolCallId,
      toolName,
      input: pending.input,
      options: jsonValue(options),
      expiresAt,
    }
    this.event('permission.requested', payload, this.activeTurnId)
    if (pending.question) {
      this.event('question.requested', {
        ...payload,
        questions: jsonValue(pending.input.questions ?? []),
        delivery: 'follow_up_prompt',
        knownGap: 'ACP permission outcomes cannot return AskUserQuestion updatedInput.answers.',
      }, this.activeTurnId)
    }
  }

  private finishPermission(
    pending: PendingPermission,
    status: string,
    optionId: string,
    answers?: Record<string, string>,
  ): void {
    clearTimeout(pending.timer)
    this.pendingPermissions.delete(pending.permissionRequestId)
    if (status === 'denied' || status === 'expired') {
      this.deniedToolCalls.add(pending.toolCallId)
    }
    const payload: Record<string, JsonValue> = {
      permissionRequestId: pending.permissionRequestId,
      toolCallId: pending.toolCallId,
      toolName: pending.toolName,
      status,
      optionId,
      ...(answers ? { answers: jsonValue(answers) } : {}),
    }
    this.event('permission.resolved', payload, pending.turnId)
    if (pending.question) this.event('question.resolved', payload, pending.turnId)
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
      return
    }

    if (type === 'tool_call' || type === 'tool_call_update') {
      this.startAssistantMessage()
      const toolCallId = typeof update.toolCallId === 'string'
        ? update.toolCallId
        : crypto.randomUUID()
      const meta = update._meta as Record<string, unknown> | undefined
      const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined
      const knownName = this.toolNames.get(toolCallId)
      const name = typeof claudeCode?.toolName === 'string'
        ? claudeCode.toolName
        : knownName ?? (typeof update.title === 'string' ? update.title : 'UnknownTool')
      this.toolNames.set(toolCallId, name)
      const payload = {
        ...jsonPayload(update),
        toolCallId,
        toolName: name,
      }
      const status = update.status
      if (status === 'completed' || status === 'failed') {
        this.openToolCalls.delete(toolCallId)
        this.deniedToolCalls.delete(toolCallId)
      } else {
        this.openToolCalls.set(toolCallId, {
          turnId: this.activeTurnId,
          payload,
        })
      }
      this.event(
        status === 'completed' || status === 'failed'
          ? 'tool.call_completed'
          : type === 'tool_call'
            ? 'tool.call_started'
            : 'tool.call_updated',
        payload,
        this.activeTurnId,
      )
      return
    }

    if (type === 'plan') {
      const payload = jsonPayload(update)
      this.event('plan.updated', payload, this.activeTurnId)
      this.event('todo.updated', payload, this.activeTurnId)
      return
    }

    if (type === 'current_mode_update' && typeof update.currentModeId === 'string') {
      this.event('session.configuration_changed', {
        permissionMode: update.currentModeId,
      }, null)
      return
    }

    if (type === 'config_option_update') {
      this.event('session.configuration_changed', {
        configOptions: jsonValue(update.configOptions ?? []),
      }, null)
    }
  }

  private emitQueue(): void {
    this.event('prompt.queue_updated', {
      depth: this.promptQueue.length,
      turnIds: this.promptQueue.map(command => command.payload.turnId),
    }, null)
  }

  private finishOpenToolCalls(): void {
    for (const [toolCallId, open] of this.openToolCalls) {
      if (open.turnId !== this.activeTurnId) continue
      const denied = this.deniedToolCalls.has(toolCallId)
      this.event('tool.call_completed', {
        ...open.payload,
        sessionUpdate: 'tool_call_update',
        status: denied ? 'failed' : 'completed',
        rawOutput: null,
        content: [],
        inferred: true,
        knownGap: missingTerminalToolResult,
      }, open.turnId)
      this.openToolCalls.delete(toolCallId)
      this.deniedToolCalls.delete(toolCallId)
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
