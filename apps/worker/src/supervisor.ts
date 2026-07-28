import type {
  HarnessEvent,
  JsonValue,
  PermissionOption,
  SessionRecoveryStrategy,
  WorkerCommand,
  WorkerToGatewayMessage,
} from '@deepharness/protocol'
import {
  AcpClient,
  type AcpClientRequest,
  type AcpUpdate,
} from './acp/client.ts'
import { activeProviderStatus, agentEnvironment } from './provider.ts'
import {
  cleanupAbandonedWorktreeStaging,
  cleanupWorkspace,
  prepareWorkspace,
  type PreparedWorkspace,
} from './workspace.ts'
import { unlink, writeFile } from 'node:fs/promises'
import { findTranscript, inspectTranscript } from './transcript.ts'
import { ActivityTracker } from './activity.ts'
import { readPersistedActivityState } from './activityState.ts'

type SendMessage = (message: WorkerToGatewayMessage) => void
type PromptCommand = Extract<WorkerCommand, { type: 'prompt' }>
type ActivityControlCommand = Extract<WorkerCommand, { type: 'stop_agent' | 'stop_task' }>

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
  'Vendor ACP ended the turn without forwarding the terminal tool_result update; the persisted result was not yet observable during bounded transcript reconciliation.'

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

class AgentSessionRuntime {
  private client: AcpClient | null = null
  private harnessSessionId: string | null = null
  private activeTurnId: string | null = null
  private assistantStarted = false
  private terminating = false
  private drainingPrompts = false
  private readonly promptQueue: PromptCommand[] = []
  private readonly activityControlQueue: ActivityControlCommand[] = []
  private readonly toolNames = new Map<string, string>()
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  private readonly questionContinuations: string[] = []
  private readonly openToolCalls = new Map<string, OpenToolCall>()
  private readonly deniedToolCalls = new Set<string>()
  private ready = false
  private vendorSessionId: string | null = null
  private activity: ActivityTracker | null = null
  private activeControl: {
    kind: 'agent' | 'task'
    id: string
    vendorId: string
  } | null = null

  constructor(
    private readonly send: SendMessage,
    private readonly prepared: PreparedWorkspace,
    private readonly onStopped: (runtime: AgentSessionRuntime) => void,
    private readonly onIdle: (runtime: AgentSessionRuntime) => void,
    private readonly onActivity: (runtime: AgentSessionRuntime) => void,
  ) {}

  get sessionId(): string | null {
    return this.harnessSessionId
  }

  get workspace(): PreparedWorkspace {
    return this.prepared
  }

  get pid(): number | null {
    return this.client?.pid ?? null
  }

  get isReady(): boolean {
    return this.ready
  }

  get agentSessionId(): string | null {
    return this.vendorSessionId
  }

  async handle(command: WorkerCommand): Promise<void> {
    try {
      if (command.type === 'start_session') await this.startSession(command)
      else if (command.type === 'prompt') this.enqueuePrompt(command)
      else if (command.type === 'cancel') this.cancel(command)
      else if (command.type === 'resolve_permission') this.resolvePermission(command)
      else if (command.type === 'set_mode') await this.setMode(command)
      else if (command.type === 'set_model') await this.setModel(command)
      else if (command.type === 'stop_agent' || command.type === 'stop_task') {
        this.enqueueActivityControl(command)
      } else await this.close(command)
      this.commandResult(command, true)
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error)
      if (command.type === 'start_session'
        && command.payload.recoveryStrategy !== 'new'
        && !message.startsWith('RECOVERY_REQUIRED:')) {
        this.event('session.recovery_changed', {
          status: 'recovery_required',
          strategy: command.payload.recoveryStrategy,
          attempted: [command.payload.recoveryStrategy],
          message,
        }, null)
        this.event('session.status_changed', {
          status: 'recovery_required',
          processState: 'stopped',
          message,
        }, null)
        this.terminating = true
        this.client?.terminate()
        message = `RECOVERY_REQUIRED:${message}`
      }
      if (command.type === 'start_session' && !message.startsWith('RECOVERY_REQUIRED:')) {
        this.event('session.status_changed', { status: 'error', message }, null)
        this.terminating = true
        this.client?.terminate()
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

  stopIdle(): void {
    if (!this.client || this.activeTurnId || this.pendingPermissions.size > 0 || this.activity?.hasActiveAgents) return
    this.terminating = true
    this.event('session.process_changed', {
      processState: 'stopped',
      reason: 'idle_ttl',
      pid: this.client.pid,
    }, null)
    this.client.terminate()
  }

  crashForTest(): void {
    this.client?.terminate('SIGKILL')
  }

  async waitForExit(): Promise<number | null> {
    return this.client ? this.client.waitForExit() : null
  }

  private async startSession(command: Extract<WorkerCommand, { type: 'start_session' }>): Promise<void> {
    if (this.client) throw new Error('Only one active Agent process is supported by this Worker')
    this.harnessSessionId = command.sessionId
    this.activity = new ActivityTracker({
      permissionMode: command.payload.permissionMode,
      workspacePath: this.prepared.cwd,
      maxActiveAgents: Math.max(1, Number.parseInt(process.env.WORKER_MAX_SUBAGENTS_PER_SESSION ?? '4', 10)),
      maxAgentDepth: Math.max(1, Number.parseInt(process.env.WORKER_MAX_SUBAGENT_DEPTH ?? '3', 10)),
      maxTeamPeers: Math.max(1, Number.parseInt(process.env.WORKER_MAX_TEAM_PEERS_PER_SESSION ?? '4', 10)),
      maxAgentTokens: Math.max(1, Number.parseInt(process.env.WORKER_MAX_SUBAGENT_TOKENS ?? '200000', 10)),
      emit: (type, payload, turnId) => this.event(type, payload, turnId),
      onPolicyViolation: reason => {
        this.event('session.interrupted', {
          reason: 'activity_policy_violation',
          message: reason,
        }, this.activeTurnId)
        this.client?.cancel()
      },
    })
    this.event('session.status_changed', { status: 'starting' }, null)
    const runtime = process.env.AGENT_RUNTIME ?? 'bun'
    const entrypoint = process.env.AGENT_ENTRYPOINT ?? '/opt/claude-code/dist/cli-bun.js'
    const client = new AcpClient({
      command: [runtime, entrypoint, '--acp'],
      cwd: this.prepared.cwd,
      env: agentEnvironment(),
      promptTimeoutMs: Math.max(1_000, Number.parseInt(
        process.env.AGENT_PROMPT_TIMEOUT_MS ?? '600000',
        10,
      )),
      onUpdate: update => this.handleUpdate(update),
      onClientRequest: request => this.handleClientRequest(request),
      onProtocolError: error => {
        this.event('session.interrupted', {
          reason: 'protocol_error',
          message: error.message,
        }, this.activeTurnId)
      },
      onExit: (exitCode, stderrTail) => {
        this.ready = false
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
        this.event('session.process_changed', {
          processState: this.terminating ? 'stopped' : 'exited',
          exitCode,
          stderrTail,
        }, this.activeTurnId)
        this.onStopped(this)
      },
    })
    this.client = client
    const initialize = await client.initialize()
    let recoveryStrategy = command.payload.recoveryStrategy
    let session: Record<string, unknown>
    try {
      session = await this.openSession(client, command.payload)
    } catch (resumeError) {
      if (recoveryStrategy !== 'resume' || !command.payload.agentSessionId) throw resumeError
      try {
        await inspectTranscript(command.payload.agentSessionId)
        session = await client.loadSession({
          sessionId: command.payload.agentSessionId,
          permissionMode: command.payload.permissionMode,
          modelId: command.payload.modelId,
        })
        recoveryStrategy = 'load'
      } catch (loadError) {
        const resumeMessage = resumeError instanceof Error ? resumeError.message : String(resumeError)
        const loadMessage = loadError instanceof Error ? loadError.message : String(loadError)
        this.event('session.recovery_changed', {
          status: 'recovery_required',
          attempted: ['resume', 'load'],
          resumeError: resumeMessage,
          loadError: loadMessage,
        }, null)
        this.event('session.status_changed', {
          status: 'recovery_required',
          processState: 'stopped',
          message: loadMessage,
        }, null)
        this.terminating = true
        client.terminate()
        throw new Error(`RECOVERY_REQUIRED:${loadMessage}`)
      }
    }
    const models = objectValue(session.models)
    const modes = objectValue(session.modes)
    const agentSessionId = String(session.sessionId)
    this.vendorSessionId = agentSessionId
    this.ready = true
    await this.reconcileActivityState(null)
    this.event('session.status_changed', {
      status: 'idle',
      processState: 'running',
      agentSessionId,
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
      recoveryStrategy,
      worktreePath: this.prepared.worktreePath,
    }, null)
    this.event('session.process_changed', {
      processState: 'running',
      pid: client.pid,
      recoveryStrategy,
      cwd: this.prepared.cwd,
    }, null)
    this.event('session.recovery_changed', {
      status: 'ready',
      strategy: recoveryStrategy,
      agentSessionId,
    }, null)
    this.event('context.updated', {
      agentSessionId,
      recoveryStrategy,
      snapshotAt: new Date().toISOString(),
      capabilities: {
        load: Boolean(objectValue(initialize.agentCapabilities).loadSession),
        resume: true,
        fork: true,
        compact: {
          state: 'vendor_managed',
          acpMethod: null,
        },
      },
      activityLimits: jsonValue(this.activity.limits),
    }, null)
    this.onIdle(this)
  }

  private async openSession(
    client: AcpClient,
    payload: Extract<WorkerCommand, { type: 'start_session' }>['payload'],
  ): Promise<Record<string, unknown>> {
    if (payload.recoveryStrategy === 'new') return client.newSession(payload)
    if (payload.recoveryStrategy === 'fork') {
      if (!payload.sourceAgentSessionId) throw new Error('Fork requires a source Agent session id')
      await inspectTranscript(payload.sourceAgentSessionId)
      return client.forkSession({
        sourceSessionId: payload.sourceAgentSessionId,
        permissionMode: payload.permissionMode,
        modelId: payload.modelId,
      })
    }
    if (!payload.agentSessionId) throw new Error('Recovery requires an Agent session id')
    await inspectTranscript(payload.agentSessionId)
    if (payload.recoveryStrategy === 'load') {
      return client.loadSession({
        sessionId: payload.agentSessionId,
        permissionMode: payload.permissionMode,
        modelId: payload.modelId,
      })
    }
    return client.resumeSession({
      sessionId: payload.agentSessionId,
      permissionMode: payload.permissionMode,
      modelId: payload.modelId,
    })
  }

  private enqueuePrompt(command: PromptCommand): void {
    if (!this.client || this.harnessSessionId !== command.sessionId) {
      throw new Error('Agent session is not active')
    }
    this.onActivity(this)
    this.promptQueue.push(command)
    this.emitQueue()
    void this.drainPromptQueue()
  }

  private async drainPromptQueue(): Promise<void> {
    if (this.drainingPrompts) return
    this.drainingPrompts = true
    try {
      while (this.promptQueue.length > 0 || this.activityControlQueue.length > 0) {
        const control = this.activityControlQueue.shift()
        if (control) {
          await this.runActivityControl(control)
          continue
        }
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
          this.idleIfEligible()
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
      await this.reconcileActivityState(this.activeTurnId, true)
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
    this.idleIfEligible()
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
    this.activity?.setPermissionMode(command.payload.modeId)
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

  private async close(command: Extract<WorkerCommand, { type: 'close_session' }>): Promise<void> {
    if (this.harnessSessionId !== command.sessionId) throw new Error('Agent session is not active')
    this.terminating = true
    try {
      await this.client?.closeSession()
    } finally {
      this.activity?.closeActive('session_closed')
      this.event('session.closed', { status: 'closed' }, null)
      this.event('session.process_changed', { processState: 'stopped', reason: 'closed' }, null)
      this.client?.terminate()
    }
  }

  private enqueueActivityControl(command: ActivityControlCommand): void {
    if (!this.client || this.harnessSessionId !== command.sessionId || !this.activity) {
      throw new Error('Agent session is not active')
    }
    const kind = command.type === 'stop_agent' ? 'agent' : 'task'
    const id = command.type === 'stop_agent' ? command.payload.agentId : command.payload.taskId
    const target = kind === 'agent'
      ? this.activity.requestAgentStop(id)
      : this.activity.requestTaskStop(id)
    if (!target) throw new Error(`${kind === 'agent' ? 'Agent' : 'Task'} activity was not found`)
    this.activityControlQueue.push(command)
    void this.drainPromptQueue()
  }

  private async runActivityControl(command: ActivityControlCommand): Promise<void> {
    if (!this.client || !this.activity) throw new Error('Agent session is not active')
    const kind = command.type === 'stop_agent' ? 'agent' : 'task'
    const id = command.type === 'stop_agent' ? command.payload.agentId : command.payload.taskId
    const vendorId = command.type === 'stop_agent'
      ? command.payload.vendorAgentId
      : command.payload.vendorTaskId
    this.activeControl = { kind, id, vendorId }
    this.onActivity(this)
    try {
      const prompt = [
        `[deepharness-control:stop-${kind}]`,
        'This is an authenticated Harness control command.',
        `Call TaskStop exactly once with task_id ${JSON.stringify(vendorId)}.`,
        'Do not perform any other action. Report a failure if TaskStop is unavailable.',
      ].join('\n')
      const result = await this.client.prompt(prompt, crypto.randomUUID())
      await this.reconcileActivityState(this.activeTurnId, true)
      this.finishOpenToolCalls()
      if (this.activity.isStopping(kind, id)) {
        this.activity.controlFailed(
          kind,
          id,
          `Vendor did not confirm TaskStop (stopReason=${String(result.stopReason ?? 'unknown')})`,
        )
      }
    } catch (error) {
      this.activity.controlFailed(kind, id, error instanceof Error ? error.message : String(error))
    } finally {
      this.activeControl = null
      this.idleIfEligible()
    }
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
    const logicalInput = toolName === 'ExecuteExtraTool'
      ? objectValue(pending.input.params)
      : pending.input
    const logicalToolName = toolName === 'ExecuteExtraTool'
      ? String(pending.input.tool_name ?? '')
      : toolName
    const requestedTaskId = String(logicalInput.task_id ?? logicalInput.shell_id ?? '')
    const controlAllow = options.find(option => /allow/i.test(`${option.kind} ${option.optionId}`))
    if (this.activeControl
      && logicalToolName === 'TaskStop'
      && requestedTaskId === this.activeControl.vendorId
      && controlAllow) {
      this.client?.respond(pending.rpcId, {
        outcome: { outcome: 'selected', optionId: controlAllow.optionId },
      })
      this.finishPermission(pending, 'approved', controlAllow.optionId)
      return
    }
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
    if (this.assistantStarted || this.activeControl) return
    this.assistantStarted = true
    this.event('assistant.message_started', {}, this.activeTurnId)
  }

  private handleUpdate(notification: AcpUpdate): void {
    const update = notification.update
    const type = update.sessionUpdate
    const meta = update._meta as Record<string, unknown> | undefined
    const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined
    const parentToolUseId = typeof claudeCode?.parentToolUseId === 'string'
      ? claudeCode.parentToolUseId
      : null
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const content = update.content as Record<string, unknown> | undefined
      if (content?.type !== 'text' || typeof content.text !== 'string') return
      if (this.activity?.observeChunk(
        parentToolUseId,
        type === 'agent_message_chunk' ? 'text' : 'reasoning',
        content.text,
      )) return
      if (this.activeControl) return
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
      const knownName = this.toolNames.get(toolCallId)
      const name = typeof claudeCode?.toolName === 'string'
        ? claudeCode.toolName
        : knownName ?? (typeof update.title === 'string' ? update.title : 'UnknownTool')
      this.toolNames.set(toolCallId, name)
      const rawInput = objectValue(update.rawInput)
      const rawOutput = update.rawOutput === undefined ? undefined : jsonValue(update.rawOutput)
      const activityRoute = this.activity?.observeTool({
        toolCallId,
        toolName: name,
        status: typeof update.status === 'string' ? update.status : 'pending',
        rawInput,
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        parentToolUseId,
        turnId: this.activeTurnId,
      })
      const payload = {
        ...jsonPayload(update),
        toolCallId,
        toolName: activityRoute?.toolName ?? name,
        rawInput: activityRoute?.rawInput ?? rawInput,
        ...(activityRoute?.rawOutput !== undefined ? { rawOutput: activityRoute.rawOutput } : {}),
        parentToolUseId,
        parentAgentId: activityRoute?.parentAgentId ?? null,
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
      if (status === 'completed' || status === 'failed') this.idleIfEligible()
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

  async resync(): Promise<void> {
    if (!this.client || !this.harnessSessionId) return
    this.event('session.process_changed', {
      processState: 'running',
      pid: this.client.pid,
      reason: 'worker_reconnected',
      cwd: this.prepared.cwd,
    }, this.activeTurnId)
    this.event('session.status_changed', {
      status: this.activeTurnId ? 'running' : 'idle',
      processState: 'running',
      agentSessionId: this.vendorSessionId,
    }, this.activeTurnId)
    await this.reconcileActivityState(this.activeTurnId)
    this.activity?.resync(this.activeTurnId)
  }

  private async reconcileActivityState(turnId: string | null, settleTranscript = false): Promise<void> {
    if (!this.vendorSessionId || !this.activity) return
    const attempts = settleTranscript ? 6 : 1
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const snapshot = await readPersistedActivityState(this.vendorSessionId)
        const reconciledToolIds = this.activity.reconcile(snapshot, turnId)
        for (const toolCallId of reconciledToolIds) {
          const open = this.openToolCalls.get(toolCallId)
          const result = snapshot.toolResults.find(candidate => candidate.toolCallId === toolCallId)
          if (!open || !result) continue
          const payload: Record<string, JsonValue> = {
            ...open.payload,
            sessionUpdate: 'tool_call_update',
            status: result.failed ? 'failed' : 'completed',
            rawOutput: result.output,
            inferred: true,
            reconciliationSource: 'vendor_transcript',
          }
          this.event('tool.call_completed', payload, open.turnId)
          this.openToolCalls.delete(toolCallId)
          this.deniedToolCalls.delete(toolCallId)
        }
        if (!settleTranscript || this.openToolCalls.size === 0 || reconciledToolIds.size > 0) return
      } catch (error) {
        console.error(JSON.stringify({
          service: 'worker',
          event: 'activity_reconciliation_failed',
          sessionId: this.harnessSessionId,
          error: error instanceof Error ? error.message : String(error),
        }))
        return
      }
      await Bun.sleep(25 * (attempt + 1))
    }
  }

  private idleIfEligible(): void {
    if (!this.activeTurnId && !this.activity?.hasActiveAgents && !this.activeControl) {
      this.onIdle(this)
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
      const payload: Record<string, JsonValue> = {
        ...open.payload,
        sessionUpdate: 'tool_call_update',
        status: denied ? 'failed' : 'completed',
        rawOutput: null,
        content: [],
        inferred: true,
        knownGap: missingTerminalToolResult,
      }
      this.activity?.observeTool({
        toolCallId,
        toolName: String(payload.toolName ?? 'UnknownTool'),
        status: denied ? 'failed' : 'completed',
        rawInput: objectValue(payload.rawInput),
        rawOutput: null,
        parentToolUseId: typeof payload.parentToolUseId === 'string' ? payload.parentToolUseId : null,
        turnId: open.turnId,
      })
      this.event('tool.call_completed', payload, open.turnId)
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

interface QueuedStart {
  command: Extract<WorkerCommand, { type: 'start_session' }>
  enqueuedAt: number
}

export class WorkerSupervisor {
  private readonly maxConcurrency = Math.max(1, Number.parseInt(
    process.env.WORKER_MAX_CONCURRENCY ?? '2',
    10,
  ))
  private readonly idleTtlMs = Math.max(0, Number.parseInt(
    process.env.AGENT_IDLE_TTL_MS ?? '900000',
    10,
  ))
  private readonly runtimes = new Map<string, AgentSessionRuntime>()
  private readonly pendingStarts: QueuedStart[] = []
  private readonly buffered = new Map<string, WorkerCommand[]>()
  private readonly commandState = new Map<string, 'running' | 'complete'>()
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly sharedLocks = new Map<string, string>()
  private readonly agentSessionIds = new Map<string, string>()
  private stopping = false

  constructor(private readonly send: SendMessage) {
    void cleanupAbandonedWorktreeStaging().then(removed => {
      if (removed > 0) console.log(JSON.stringify({
        service: 'worker',
        event: 'abandoned_worktree_staging_removed',
        removed,
      }))
    })
  }

  get concurrency(): number {
    return this.maxConcurrency
  }

  get activeProcessCount(): number {
    return this.runtimes.size
  }

  get queuedProcessCount(): number {
    return this.pendingStarts.length
  }

  async resync(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.resync()))
  }

  async handle(command: WorkerCommand): Promise<void> {
    const prior = this.commandState.get(command.id)
    if (prior === 'complete') {
      this.commandResult(command, true)
      return
    }
    if (prior === 'running') return
    this.commandState.set(command.id, 'running')

    if (command.type === 'start_session') {
      await this.acceptStart(command)
      return
    }
    if (command.type === 'close_session') {
      const queuedIndex = this.pendingStarts.findIndex(item => item.command.sessionId === command.sessionId)
      if (queuedIndex >= 0) {
        const [queued] = this.pendingStarts.splice(queuedIndex, 1)
        const buffered = this.buffered.get(command.sessionId) ?? []
        this.buffered.delete(command.sessionId)
        if (queued) {
          this.commandState.set(queued.command.id, 'complete')
          this.commandResult(queued.command, false, 'Session closed before the Agent process started')
        }
        for (const pending of buffered) {
          this.commandState.set(pending.id, 'complete')
          this.commandResult(pending, false, 'Session closed before the Agent process started')
        }
        this.emit(command.sessionId, 'session.closed', { status: 'closed' })
        this.emit(command.sessionId, 'session.process_changed', {
          processState: 'stopped',
          reason: 'closed_while_queued',
        })
        this.commandState.set(command.id, 'complete')
        this.commandResult(command, true)
        this.releaseSharedLock(command.sessionId)
        await this.drainStarts()
        return
      }
    }
    const runtime = this.runtimes.get(command.sessionId)
    if (runtime) {
      if (command.type === 'close_session') {
        await runtime.handle(command)
        await runtime.waitForExit()
        const result = await cleanupWorkspace(runtime.workspace, command.payload.removeCleanWorktree)
        this.emit(command.sessionId, 'workspace.lock_changed', {
          locked: false,
          worktreeRemoved: result.removed,
          dirtyWorktreeRetained: result.dirty,
        })
        return
      }
      if (!runtime.isReady) {
        this.commandState.set(command.id, 'complete')
        this.commandResult(command, false, 'Agent process did not reach a recoverable ready state')
        return
      }
      await runtime.handle(command)
      return
    }
    if (this.pendingStarts.some(item => item.command.sessionId === command.sessionId)) {
      const commands = this.buffered.get(command.sessionId) ?? []
      commands.push(command)
      this.buffered.set(command.sessionId, commands)
      return
    }
    if (command.type === 'close_session') {
      this.commandState.set(command.id, 'complete')
      this.commandResult(command, true)
      return
    }
    this.commandState.set(command.id, 'complete')
    this.commandResult(command, false, 'Agent process is stopped; a recovery start command is required')
  }

  private async acceptStart(command: Extract<WorkerCommand, { type: 'start_session' }>): Promise<void> {
    if (this.runtimes.has(command.sessionId)) {
      this.commandState.set(command.id, 'complete')
      this.commandResult(command, true)
      return
    }
    const sameQueued = this.pendingStarts.find(item => item.command.sessionId === command.sessionId)
    if (sameQueued) return
    this.pendingStarts.push({ command, enqueuedAt: Date.now() })
    this.emit(command.sessionId, 'session.process_changed', {
      processState: 'queued',
      queuePosition: this.pendingStarts.length,
      maxConcurrency: this.maxConcurrency,
    })
    await this.drainStarts()
  }

  private async drainStarts(): Promise<void> {
    while (!this.stopping && this.runtimes.size < this.maxConcurrency && this.pendingStarts.length > 0) {
      const index = this.pendingStarts.findIndex(item => this.canAcquire(item.command))
      if (index < 0) return
      const [queued] = this.pendingStarts.splice(index, 1)
      if (!queued) return
      await this.launch(queued)
    }
    this.emitQueuePositions()
  }

  private canAcquire(command: Extract<WorkerCommand, { type: 'start_session' }>): boolean {
    if (command.payload.workspaceMode !== 'shared') return true
    const owner = this.sharedLocks.get(command.payload.workspaceId)
    return !owner || owner === command.sessionId
  }

  private async launch(queued: QueuedStart): Promise<void> {
    const command = queued.command
    try {
      if (command.payload.workspaceMode === 'shared') {
        this.sharedLocks.set(command.payload.workspaceId, command.sessionId)
      }
      const prepared = await prepareWorkspace({
        sessionId: command.sessionId,
        workspacePath: command.payload.workspacePath,
        workspaceMode: command.payload.workspaceMode,
      })
      const runtime = new AgentSessionRuntime(
        message => this.fromRuntime(message),
        prepared,
        stopped => this.runtimeStopped(stopped),
        idle => this.runtimeIdle(idle),
        active => this.runtimeActive(active),
      )
      this.runtimes.set(command.sessionId, runtime)
      await runtime.handle(command)
      const buffered = this.buffered.get(command.sessionId) ?? []
      this.buffered.delete(command.sessionId)
      if (!runtime.isReady) {
        for (const next of buffered) {
          this.commandState.set(next.id, 'complete')
          this.commandResult(next, false, 'Session recovery did not produce an active Agent process')
        }
        return
      }
      for (const next of buffered) await runtime.handle(next)
    } catch (error) {
      this.releaseSharedLock(command.sessionId)
      const message = error instanceof Error ? error.message : String(error)
      const recovery = command.payload.recoveryStrategy !== 'new'
      if (recovery) {
        this.emit(command.sessionId, 'session.recovery_changed', {
          status: 'recovery_required',
          strategy: command.payload.recoveryStrategy,
          attempted: [command.payload.recoveryStrategy],
          message,
        })
      }
      this.emit(command.sessionId, 'session.status_changed', {
        status: recovery ? 'recovery_required' : 'error',
        processState: 'stopped',
        message,
      })
      this.emit(command.sessionId, 'session.process_changed', {
        processState: 'stopped',
        reason: 'workspace_prepare_failed',
      })
      this.commandState.set(command.id, 'complete')
      this.commandResult(command, false, message)
    }
  }

  private fromRuntime(message: WorkerToGatewayMessage): void {
    if (message.kind === 'command_result') {
      this.commandState.set(message.commandId, 'complete')
      if (this.commandState.size > 2_000) {
        const first = this.commandState.keys().next().value
        if (first) this.commandState.delete(first)
      }
    }
    this.send(message)
  }

  private runtimeActive(runtime: AgentSessionRuntime): void {
    const sessionId = runtime.sessionId
    if (!sessionId) return
    const timer = this.idleTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.idleTimers.delete(sessionId)
  }

  private runtimeIdle(runtime: AgentSessionRuntime): void {
    const sessionId = runtime.sessionId
    if (!sessionId || this.idleTtlMs === 0) return
    this.runtimeActive(runtime)
    this.idleTimers.set(sessionId, setTimeout(() => runtime.stopIdle(), this.idleTtlMs))
  }

  private runtimeStopped(runtime: AgentSessionRuntime): void {
    const sessionId = runtime.sessionId
    if (!sessionId) return
    const current = this.runtimes.get(sessionId)
    if (current !== runtime) return
    this.runtimes.delete(sessionId)
    if (runtime.agentSessionId) this.agentSessionIds.set(sessionId, runtime.agentSessionId)
    this.runtimeActive(runtime)
    this.releaseSharedLock(sessionId)
    void this.drainStarts()
  }

  private releaseSharedLock(sessionId: string): void {
    for (const [workspaceId, owner] of this.sharedLocks) {
      if (owner === sessionId) this.sharedLocks.delete(workspaceId)
    }
  }

  private emitQueuePositions(): void {
    this.pendingStarts.forEach((item, index) => this.emit(
      item.command.sessionId,
      'session.process_changed',
      { processState: 'queued', queuePosition: index + 1, maxConcurrency: this.maxConcurrency },
    ))
  }

  private emit(
    sessionId: string,
    type: HarnessEvent['type'],
    payload: Record<string, JsonValue>,
  ): void {
    this.send({
      kind: 'event',
      event: {
        id: crypto.randomUUID(),
        sessionId,
        turnId: null,
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

  async closeSession(sessionId: string, removeCleanWorktree = true): Promise<void> {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    await runtime.handle({
      id: crypto.randomUUID(),
      type: 'close_session',
      sessionId,
      payload: { removeCleanWorktree },
    })
    await runtime.waitForExit()
    const result = await cleanupWorkspace(runtime.workspace, removeCleanWorktree)
    this.emit(sessionId, 'workspace.lock_changed', {
      locked: false,
      worktreeRemoved: result.removed,
      dirtyWorktreeRetained: result.dirty,
    })
  }

  crashSessionForTest(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    runtime.crashForTest()
    return true
  }

  stopSessionForTest(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    runtime.stopIdle()
    return true
  }

  async damageTranscriptForTest(
    sessionId: string,
    action: 'delete' | 'corrupt',
  ): Promise<boolean> {
    const agentSessionId = this.runtimes.get(sessionId)?.agentSessionId
      ?? this.agentSessionIds.get(sessionId)
    if (!agentSessionId) return false
    const transcript = await findTranscript(agentSessionId)
    if (!transcript) return false
    if (action === 'delete') await unlink(transcript)
    else await writeFile(transcript, '{"type":"corrupted"\n', 'utf8')
    return true
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    const runtimes = [...this.runtimes.values()]
    for (const runtime of runtimes) runtime.shutdown()
    const graceMs = Math.max(250, Number.parseInt(process.env.AGENT_SHUTDOWN_GRACE_MS ?? '5000', 10))
    await Promise.race([
      Promise.all(runtimes.map(runtime => runtime.waitForExit())),
      Bun.sleep(graceMs),
    ])
    for (const runtime of runtimes) runtime.crashForTest()
  }
}
