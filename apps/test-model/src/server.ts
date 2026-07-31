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

function toolUseResponse(body: RequestBody, toolName: string, toolInput: Record<string, unknown>): Response {
  const model = body.model ?? 'claude-sonnet-4-6'
  const toolId = `toolu_${crypto.randomUUID().replaceAll('-', '')}`
  const input = JSON.stringify(toolInput)
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

function findTool(body: RequestBody, names: string[]): string | null {
  for (const name of names) {
    const exact = body.tools?.find(tool => tool.name?.toLowerCase() === name.toLowerCase())
    if (exact?.name) return exact.name
  }
  for (const name of names) {
    const partial = body.tools?.find(tool => tool.name?.toLowerCase().includes(name.toLowerCase()))
    if (partial?.name) return partial.name
  }
  return null
}

function toolUses(body: RequestBody): Array<Record<string, unknown>> {
  return (body.messages ?? []).flatMap(message => blocks(message)
    .filter(block => block.type === 'tool_use'))
}

function latestToolUse(body: RequestBody): Record<string, unknown> | null {
  return toolUses(body).at(-1) ?? null
}

function hasDiscoveredTool(body: RequestBody, name: string): boolean {
  return toolUses(body).some(tool => {
    if (String(tool.name ?? '').toLowerCase() !== 'searchextratools') return false
    const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input)
      ? tool.input as Record<string, unknown>
      : {}
    const query = String(input.query ?? '')
    const selected = query.match(/^select:(.+)$/i)?.[1]
      ?.split(',')
      .map(value => value.trim().toLowerCase())
      ?? []
    return selected.includes(name.toLowerCase())
  })
}

function logicalTool(
  body: RequestBody,
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } | null {
  const direct = findTool(body, [name])
  if (direct) return { name: direct, input }
  const deferred = findTool(body, ['ExecuteExtraTool'])
  if (!deferred) return null
  if (!hasDiscoveredTool(body, name)) {
    const search = findTool(body, ['SearchExtraTools'])
    if (search) return { name: search, input: { query: `select:${name}` } }
  }
  return { name: deferred, input: { tool_name: name, params: input } }
}

function markerValue(prompt: string, marker: string, fallback: string): string {
  const match = prompt.match(new RegExp(`${marker}:([^\\s\\]]+)`, 'i'))
  return match?.[1] ?? fallback
}

function requestedTool(body: RequestBody, prompt: string): { name: string; input: Record<string, unknown> } | null {
  const normalized = prompt.toLowerCase()
  const shutdownRequestId = prompt.match(/"requestId"\s*:\s*"([^"]+)"/i)?.[1]
  if (normalized.includes('"type":"shutdown_request"') && shutdownRequestId) {
    return logicalTool(body, 'SendMessage', {
      to: 'team-lead',
      message: {
        type: 'shutdown_response',
        request_id: shutdownRequestId,
        approve: true,
      },
    })
  }
  if (normalized.includes('[subagent:level-1]')) {
    return logicalTool(body, 'Agent', {
      description: 'Nested level two agent',
      prompt: '[subagent:level-2] Return NESTED_AGENT_LEVEL_2_OK.',
      subagent_type: 'Explore',
    })
  }
  if (normalized.includes('[tool:agent-nested]')) {
    return logicalTool(body, 'Agent', {
      description: 'Nested level one agent',
      prompt: '[subagent:level-1] Spawn the requested nested agent.',
      subagent_type: 'general-purpose',
    })
  }
  if (normalized.includes('[tool:team-agent]')) {
    return logicalTool(body, 'Agent', {
      description: 'Named coordinator teammate',
      prompt: '[subagent:team] Return TEAM_AGENT_READY and wait for messages.',
      subagent_type: 'general-purpose',
      name: markerValue(prompt, 'agent-name', 'builder'),
      team_name: markerValue(prompt, 'team-name', 'phase-four-team'),
      run_in_background: true,
    })
  }
  if (normalized.includes('[tool:agent-async]')) {
    return logicalTool(body, 'Agent', {
      description: 'Long running background agent',
      prompt: `[subagent:async] ${'keep working '.repeat(80)}`,
      subagent_type: 'general-purpose',
      run_in_background: true,
    })
  }
  if (normalized.includes('[tool:agent-plan]')) {
    return logicalTool(body, 'Agent', {
      description: 'Built-in Plan phase four agent',
      prompt: '[subagent:plan] Return PLAN_AGENT_OK.',
      subagent_type: 'Plan',
    })
  }
  if (normalized.includes('[tool:agent-verification]')) {
    return logicalTool(body, 'Agent', {
      description: 'Built-in verification phase four agent',
      prompt: '[subagent:verification] Return VERIFICATION_AGENT_OK.',
      subagent_type: 'verification',
    })
  }
  if (normalized.includes('[tool:agent-custom]')) {
    return logicalTool(body, 'Agent', {
      description: 'Project custom phase four agent',
      prompt: '[subagent:custom] Return CUSTOM_AGENT_OK.',
      subagent_type: 'phase-four-checker',
    })
  }
  if (normalized.includes('[tool:agent]')) {
    return logicalTool(body, 'Agent', {
      description: 'Synchronous phase four agent',
      prompt: '[subagent:sync] Return SYNC_AGENT_OK.',
      subagent_type: 'Explore',
    })
  }
  if (normalized.includes('[tool:task-create]')) {
    return logicalTool(body, 'TaskCreate', {
      subject: markerValue(prompt, 'task-subject', 'Phase four task'),
      description: 'Created by the deterministic phase four ACP test.',
      activeForm: 'Running phase four task',
    })
  }
  if (normalized.includes('[tool:task-get]')) {
    return logicalTool(body, 'TaskGet', { taskId: markerValue(prompt, 'task-id', '1') })
  }
  if (normalized.includes('[tool:task-list]')) return logicalTool(body, 'TaskList', {})
  if (normalized.includes('[tool:task-update]')) {
    return logicalTool(body, 'TaskUpdate', {
      taskId: markerValue(prompt, 'task-id', '1'),
      status: markerValue(prompt, 'task-status', 'in_progress'),
      owner: markerValue(prompt, 'task-owner', 'team-lead'),
      metadata: { phase: 4 },
    })
  }
  if (normalized.includes('[tool:task-output]')) {
    return logicalTool(body, 'TaskOutput', {
      task_id: markerValue(prompt, 'task-id', '1'),
      block: false,
      timeout: 0,
    })
  }
  if (normalized.includes('[tool:task-stop]')) {
    return logicalTool(body, 'TaskStop', { task_id: markerValue(prompt, 'task-id', '1') })
  }
  if (normalized.includes('[tool:team-create]')) {
    return logicalTool(body, 'TeamCreate', {
      team_name: markerValue(prompt, 'team-name', 'phase-four-team'),
      description: 'Deterministic phase four coordinator team',
    })
  }
  if (normalized.includes('[tool:team-delete]')) return logicalTool(body, 'TeamDelete', { wait_ms: 1000 })
  if (normalized.includes('[tool:send-message]')) {
    return logicalTool(body, 'SendMessage', {
      to: markerValue(prompt, 'message-to', 'team-lead'),
      summary: 'Phase four routed message',
      message: 'PHASE_FOUR_TEAM_MESSAGE_OK',
    })
  }
  if (normalized.includes('[tool:list-peers]')) return logicalTool(body, 'ListPeers', { include_self: true })
  if (normalized.includes('[tool:skill]')) {
    return logicalTool(body, 'Skill', {
      skill: 'phase-five-skill',
      args: 'PHASE_FIVE_SKILL_TOOL_ARG',
    })
  }
  if (normalized.includes('[tool:local-memory]')) {
    return logicalTool(body, 'LocalMemoryRecall', {
      action: 'fetch',
      store: markerValue(prompt, 'memory-store', 'phase-six'),
      key: markerValue(prompt, 'memory-key', 'verification'),
      preview_only: true,
    })
  }
  if (normalized.includes('[tool:vault-http]')) {
    return logicalTool(body, 'VaultHttpFetch', {
      url: 'https://api.example.test/private/items?source=phase-six#verification',
      method: 'GET',
      vault_auth_key: 'phase-six-missing-key',
      auth_scheme: 'bearer',
      reason: 'Verify the redacted Vault failure projection.',
    })
  }
  if (normalized.includes('[deepharness-control:stop-agent]')
    || normalized.includes('[deepharness-control:stop-task]')) {
    const taskId = prompt.match(/task_id\s+"([^"]+)"/i)?.[1]
      ?? markerValue(prompt, 'task-id', '')
    return taskId ? logicalTool(body, 'TaskStop', { task_id: taskId }) : null
  }
  const scenarios: Array<{ marker: string; names: string[]; input: Record<string, unknown> }> = [
    {
      marker: '[tool:read]',
      names: ['Read', 'FileRead'],
      input: { file_path: '/workspace/source/phase-1-marker.txt' },
    },
    {
      marker: '[tool:write]',
      names: ['Write', 'FileWrite'],
      input: {
        file_path: '/tmp/deepharness-phase2.ipynb',
        content: '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n',
      },
    },
    {
      marker: '[tool:edit]',
      names: ['Edit', 'FileEdit'],
      input: {
        file_path: '/tmp/deepharness-phase2.ipynb',
        old_string: '"nbformat_minor":5',
        new_string: '"nbformat_minor":4',
      },
    },
    {
      marker: '[tool:bash]',
      names: ['Bash'],
      input: { command: "printf 'DEEPHARNESS_PHASE_2_BASH_OK'" },
    },
    {
      marker: '[tool:glob]',
      names: ['Glob'],
      input: { pattern: 'phase-1-marker.txt', path: '/workspace/source' },
    },
    {
      marker: '[tool:grep]',
      names: ['Grep'],
      input: {
        pattern: 'DEEPHARNESS_PHASE_1_WORKSPACE_READ_OK',
        path: '/workspace/source/phase-1-marker.txt',
        output_mode: 'content',
      },
    },
    {
      marker: '[tool:notebook]',
      names: ['NotebookEdit'],
      input: {
        notebook_path: '/tmp/deepharness-phase2.ipynb',
        new_source: 'print("DEEPHARNESS_PHASE_2_NOTEBOOK_OK")',
        cell_type: 'code',
        edit_mode: 'insert',
      },
    },
    {
      marker: '[tool:todo]',
      names: ['TodoWrite'],
      input: {
        todos: [
          { content: 'Inspect the core tool bridge', status: 'completed', activeForm: 'Inspecting the core tool bridge' },
          { content: 'Verify the phase 2 renderer', status: 'in_progress', activeForm: 'Verifying the phase 2 renderer' },
        ],
      },
    },
    {
      marker: '[tool:plan]',
      names: ['EnterPlanMode'],
      input: {},
    },
    {
      marker: '[tool:question]',
      names: ['AskUserQuestion'],
      input: {
        questions: [{
          question: 'Which verification path should continue?',
          header: 'Verification',
          multiSelect: false,
          options: [
            { label: 'Contract tests', description: 'Continue with deterministic ACP contracts.' },
            { label: 'Manual smoke', description: 'Continue with a credentialed smoke profile.' },
          ],
        }],
      },
    },
  ]
  const scenario = scenarios.find(candidate => prompt.toLowerCase().includes(candidate.marker))
  if (!scenario) return null
  const name = findTool(body, scenario.names)
  return name ? { name, input: scenario.input } : null
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
    const prompt = userText(body)
    const result = toolResult(body)
    if (result !== null) {
      const latest = latestToolUse(body)
      if (String(latest?.name ?? '').toLowerCase() === 'searchextratools') {
        const requested = requestedTool(body, prompt)
        if (requested) return toolUseResponse(body, requested.name, requested.input)
      }
      if (prompt.toLowerCase().includes('[tool:local-memory]')) {
        return textResponse(body, 'LOCAL_MEMORY_RECALL_OK', 20)
      }
      if (prompt.toLowerCase().includes('[tool:vault-http]')) {
        return textResponse(body, 'VAULT_HTTP_FAILURE_OBSERVED', 20)
      }
      return textResponse(body, `Tool completed through ACP:\n${result}`, 20)
    }
    if (prompt.toLowerCase().includes('[subagent:level-2]')) {
      return textResponse(body, 'NESTED_AGENT_LEVEL_2_OK', 25)
    }
    if (prompt.toLowerCase().includes('[subagent:sync]')) {
      return textResponse(body, 'SYNC_AGENT_OK', 25)
    }
    if (prompt.toLowerCase().includes('[subagent:plan]')) {
      return textResponse(body, 'PLAN_AGENT_OK', 25)
    }
    if (prompt.toLowerCase().includes('[subagent:verification]')) {
      return textResponse(body, 'VERIFICATION_AGENT_OK', 25)
    }
    if (prompt.toLowerCase().includes('[subagent:custom]')) {
      return textResponse(body, 'CUSTOM_AGENT_OK', 25)
    }
    if (prompt.toLowerCase().includes('[subagent:async]')) {
      return textResponse(body, `ASYNC_AGENT ${'working '.repeat(160)}`, 100)
    }
    if (prompt.toLowerCase().includes('[subagent:team]')) {
      return textResponse(body, 'TEAM_AGENT_READY', 35)
    }
    if (prompt.toLowerCase().includes('[tool:unknown]')) {
      return toolUseResponse(body, 'FutureHarnessTool', {
        payload: '<script>window.__deepharnessUnsafeToolExecuted = true</script>',
        nested: { retained: true },
      })
    }
    const requested = requestedTool(body, prompt)
    if (requested) return toolUseResponse(body, requested.name, requested.input)
    if (/phase-1-marker\.txt|workspace marker/i.test(prompt)) {
      const tool = body.tools?.find(candidate => /^(read|fileread)$/i.test(candidate.name ?? ''))
        ?? body.tools?.find(candidate => /read/i.test(candidate.name ?? ''))
      if (tool?.name) return toolUseResponse(body, tool.name, {
        file_path: '/workspace/source/phase-1-marker.txt',
      })
    }
    if (prompt.includes('[queue]')) {
      return textResponse(body, `Queue stream ${'working '.repeat(50)}`, 75)
    }
    if (prompt.includes('[slow]')) {
      return textResponse(body, `Slow stream ${'still running '.repeat(100)}`, 250)
    }
    return textResponse(body, `DeepHarness test model received: ${prompt}`, 35)
  },
})

console.log(JSON.stringify({ service: 'test-model', event: 'started', port: server.port }))
