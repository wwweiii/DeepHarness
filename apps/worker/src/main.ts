const port = Number.parseInt(process.env.PORT ?? '8081', 10)

Bun.serve({
  hostname: '0.0.0.0',
  port,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/healthz' || path === '/readyz') {
      return Response.json({
        service: 'worker',
        status: 'ok',
        agentBoundary: 'acp-stdio',
        processIsolation: 'one-active-session-per-process',
        dockerSocketMounted: false,
      })
    }
    return new Response('DeepHarness Worker baseline\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
})

console.log(JSON.stringify({ service: 'worker', event: 'started', port }))
