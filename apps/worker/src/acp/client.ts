type JsonObject = Record<string, unknown>

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: JsonObject
  result?: JsonObject
  error?: { code?: number; message?: string; data?: unknown }
}

interface PendingRequest {
  resolve: (value: JsonObject) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface AcpUpdate {
  sessionId: string
  update: Record<string, unknown>
}

export interface AcpClientRequest {
  id: number | string
  method: string
  params: JsonObject
}

export interface AcpClientOptions {
  command: string[]
  cwd: string
  env: Record<string, string>
  onUpdate: (update: AcpUpdate) => void
  onClientRequest: (request: AcpClientRequest) => void
  onExit: (exitCode: number, stderrTail: string[]) => void
  onProtocolError: (error: Error) => void
}

function redact(line: string): string {
  return line
    .replace(/(api[_-]?key|auth[_-]?token|secret)(["'=:\s]+)[^\s,"']+/gi, '$1$2[REDACTED]')
    .slice(0, 4_000)
}

export class AcpClient {
  private readonly process: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly writer: Bun.Subprocess<'pipe', 'pipe', 'pipe'>['stdin']
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly stderrTail: string[] = []
  private nextId = 1
  private exited = false
  private sessionId: string | null = null

  constructor(private readonly options: AcpClientOptions) {
    this.process = Bun.spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    this.writer = this.process.stdin
    void this.readStdout()
    void this.readStderr()
    void this.watchExit()
  }

  async initialize(): Promise<JsonObject> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { terminal: false },
      clientInfo: { name: 'deepharness-worker', version: '0.2.0' },
    }, 30_000)
  }

  async newSession(input: {
    permissionMode: string
    modelId: string | null
  }): Promise<JsonObject> {
    const result = await this.request('session/new', {
      cwd: this.options.cwd,
      mcpServers: [],
      _meta: { permissionMode: input.permissionMode },
    }, 60_000)
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string') throw new Error('ACP session/new returned no sessionId')
    this.sessionId = sessionId
    if (input.modelId) {
      await this.request('session/set_model', {
        sessionId,
        modelId: input.modelId,
      }, 30_000)
    }
    return result
  }

  async prompt(text: string, messageId: string): Promise<JsonObject> {
    if (!this.sessionId) throw new Error('ACP session has not been created')
    return this.request('session/prompt', {
      sessionId: this.sessionId,
      messageId,
      prompt: [{ type: 'text', text }],
    }, 10 * 60_000)
  }

  async setMode(modeId: string): Promise<JsonObject> {
    if (!this.sessionId) throw new Error('ACP session has not been created')
    return this.request('session/set_mode', {
      sessionId: this.sessionId,
      modeId,
    }, 30_000)
  }

  async setModel(modelId: string): Promise<JsonObject> {
    if (!this.sessionId) throw new Error('ACP session has not been created')
    return this.request('session/set_model', {
      sessionId: this.sessionId,
      modelId,
    }, 30_000)
  }

  respond(id: number | string, result: JsonObject): void {
    if (this.exited) return
    this.write({ jsonrpc: '2.0', id, result })
  }

  reject(id: number | string, code: number, message: string): void {
    if (this.exited) return
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  cancel(): void {
    if (!this.sessionId || this.exited) return
    this.notify('session/cancel', { sessionId: this.sessionId })
  }

  terminate(): void {
    if (this.exited) return
    this.process.kill('SIGTERM')
  }

  private request(method: string, params: JsonObject, timeoutMs: number): Promise<JsonObject> {
    if (this.exited) return Promise.reject(new Error('ACP process has exited'))
    const id = this.nextId++
    const promise = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.write({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  private notify(method: string, params: JsonObject): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: RpcMessage): void {
    this.writer.write(`${JSON.stringify(message)}\n`)
    this.writer.flush()
  }

  private async readStdout(): Promise<void> {
    const reader = this.process.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            this.handleMessage(JSON.parse(line) as RpcMessage)
          } catch (error) {
            this.options.onProtocolError(new Error(
              `Non-ACP stdout received: ${line.slice(0, 300)}`,
              { cause: error },
            ))
          }
        }
      }
      if (buffer.trim()) {
        this.options.onProtocolError(new Error(`Truncated ACP stdout: ${buffer.slice(0, 300)}`))
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.process.stderr.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = redact(raw)
          if (!line) continue
          this.stderrTail.push(line)
          if (this.stderrTail.length > 100) this.stderrTail.shift()
          console.error(JSON.stringify({ service: 'worker', event: 'agent_stderr', line }))
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(
          `ACP error ${message.error.code ?? 'unknown'}: ${message.error.message ?? 'Unknown error'}`,
        ))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }

    if (message.method === 'session/update') {
      const params = message.params
      if (typeof params?.sessionId === 'string' && params.update && typeof params.update === 'object') {
        this.options.onUpdate({
          sessionId: params.sessionId,
          update: params.update as Record<string, unknown>,
        })
      }
      return
    }

    if (message.id !== undefined && message.method) {
      this.options.onClientRequest({
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      })
    }
  }

  private async watchExit(): Promise<void> {
    const exitCode = await this.process.exited
    this.exited = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`ACP process exited with code ${exitCode}`))
    }
    this.pending.clear()
    this.options.onExit(exitCode, [...this.stderrTail])
  }
}
