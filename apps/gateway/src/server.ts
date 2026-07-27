const port = Number.parseInt(process.env.PORT ?? '8080', 10)

Bun.serve({
  hostname: '0.0.0.0',
  port,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/healthz' || path === '/readyz') {
      return Response.json({
        service: 'gateway',
        status: 'ok',
        vendorAccess: false,
        dockerSocketMounted: false,
      })
    }
    return new Response('DeepHarness Gateway baseline\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  },
})

console.log(JSON.stringify({ service: 'gateway', event: 'started', port }))
