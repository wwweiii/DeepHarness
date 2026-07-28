const port = Number.parseInt(process.env.PORT ?? '8090', 10)
const encoder = new TextEncoder()

type Message = {
  role?: string
  content?: string | Array<Record<string, unknown>>
}

type RequestBody = {
  model?: string
  messages?: Message[]
  tools?: Array<{ name?: string }>
  stream?: boolean
}

function blocks(message: Message | undefined): Array<Record<string, unknown>> {
  if (!message) return []
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
  return Array.isArray(message.content) ? message.content : []
}

function userText(body: RequestBody): string {
  const messages = body.messages ?? []
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue
    const text = blocks(message)
      .filter(block => block.type === 'text')
      .map(block => String(block.text ?? ''))
      .map(value => value.trim())
      .filter(value => value && !value.startsWith('<system-reminder>'))
      .join('\n')
    if (text) return text
  }
  return ''
}

function toolResult(body: RequestBody): string | null {
  const latest = body.messages?.at(-1)
  if (latest?.role !== 'user') return null
  for (const block of blocks(latest)) {
    if (block.type !== 'tool_result') continue
    if (typeof block.content === 'string') return block.content
    if (Array.isArray(block.content)) {
      return block.content
        .filter(item => item && typeof item === 'object')
        .map(item => String((item as Record<string, unknown>).text ?? ''))
        .join('\n')
    }
  }
  return null
}

function sse(event: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function messageStart(model: string): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: `msg_${crypto.randomUUID().replaceAll('-', '')}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 17, output_tokens: 0 },
    },
  }
}

function textResponse(body: RequestBody, text: string, delayMs: number): Response {
  const model = body.model ?? 'claude-sonnet-4-6'
  const chunks = text.match(/.{1,12}/gs) ?? ['']
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(sse('message_start', messageStart(model)))
        controller.enqueue(sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }))
        for (const chunk of chunks) {
          if (delayMs > 0) await Bun.sleep(delayMs)
          controller.enqueue(sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: chunk },
          }))
        }
        controller.enqueue(sse('content_block_stop', {
          type: 'content_block_stop',
          index: 0,
        }))
        controller.enqueue(sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: Math.max(1, Math.ceil(text.length / 4)) },
        }))
        controller.enqueue(sse('message_stop', { type: 'message_stop' }))
        controller.close()
      } catch {
        try { controller.close() } catch { /* client cancelled */ }
      }
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}

function toolUseResponse(body: RequestBody, toolName: string): Response {
  const model = body.model ?? 'claude-sonnet-4-6'
  const toolId = `toolu_${crypto.randomUUID().replaceAll('-', '')}`
  const input = JSON.stringify({ file_path: '/workspace/source/phase-1-marker.txt' })
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(sse('message_start', messageStart(model)))
      controller.enqueue(sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
      }))
      for (const piece of [input.slice(0, 24), input.slice(24)]) {
        controller.enqueue(sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: piece },
        }))
        await Bun.sleep(25)
      }
      controller.enqueue(sse('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      }))
      controller.enqueue(sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 22 },
      }))
      controller.enqueue(sse('message_stop', { type: 'message_stop' }))
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

const server = Bun.serve({
  hostname: '0.0.0.0',
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') {
      return Response.json({ service: 'test-model', status: 'ok' })
    }
    if (url.pathname.endsWith('/messages/count_tokens')) {
      return Response.json({ input_tokens: 17 })
    }
    if (!url.pathname.endsWith('/messages') || request.method !== 'POST') {
      return Response.json({ error: { type: 'not_found_error', message: 'Not found' } }, { status: 404 })
    }
    const body = await request.json() as RequestBody
    if (process.env.TEST_MODEL_DEBUG === '1') {
      console.log(JSON.stringify({
        service: 'test-model',
        event: 'request_shape',
        systemTail: typeof (body as Record<string, unknown>).system === 'string'
          ? String((body as Record<string, unknown>).system).slice(-300)
          : null,
        messages: (body.messages ?? []).map(message => ({
          role: message.role,
          blocks: blocks(message).map(block => ({
            type: block.type,
            text: typeof block.text === 'string' ? block.text.slice(0, 300) : undefined,
          })),
        })),
      }))
    }
    const result = toolResult(body)
    if (result !== null) {
      return textResponse(body, `Workspace marker read through ACP:\n${result}`, 20)
    }
    const prompt = userText(body)
    if (/phase-1-marker\.txt|workspace marker/i.test(prompt)) {
      const tool = body.tools?.find(candidate => /^(read|fileread)$/i.test(candidate.name ?? ''))
        ?? body.tools?.find(candidate => /read/i.test(candidate.name ?? ''))
      if (tool?.name) return toolUseResponse(body, tool.name)
    }
    if (prompt.includes('[slow]')) {
      return textResponse(body, `Slow stream ${'still running '.repeat(100)}`, 250)
    }
    return textResponse(body, `DeepHarness test model received: ${prompt}`, 35)
  },
})

console.log(JSON.stringify({ service: 'test-model', event: 'started', port: server.port }))
