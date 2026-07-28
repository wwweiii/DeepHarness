const targets = [
  'http://gateway:8080/health/ready',
  'http://worker:8081/health/ready',
]
const deadline = Date.now() + 60_000
let pending = [...targets]

while (pending.length > 0 && Date.now() < deadline) {
  const checks = await Promise.all(pending.map(async url => ({
    url,
    ready: await fetch(url).then(response => response.ok).catch(() => false),
  })))
  pending = checks.filter(check => !check.ready).map(check => check.url)
  if (pending.length > 0) await Bun.sleep(250)
}

if (pending.length > 0) {
  throw new Error(`Stack did not become ready: ${pending.join(', ')}`)
}

console.log(JSON.stringify({ event: 'test_stack_ready', targets }))
