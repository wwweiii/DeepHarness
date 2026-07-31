# Operations Runbook

The Gateway is the control-plane entrypoint. `/health/live` checks process liveness, `/health/ready` checks PostgreSQL and reports Worker connectivity, and `/metrics` exposes Prometheus text metrics. Set `METRICS_TOKEN` to require `Authorization: Bearer ...` for metrics scraping. Logs are one-line JSON with `service`, `event`, `requestId`, status, and duration; request bodies, cookies, authorization headers, and provider secrets are never logged.

Routine checks:

- `docker compose ps` and `docker compose logs --since=10m gateway worker`.
- `curl -fsS http://127.0.0.1:8080/health/ready`.
- `curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:8080/metrics` when a metrics token is configured.
- `make capability-gate` after every vendor or Harness image build.

The single-user session uses an HttpOnly `deepharness_session` cookie and a separate `deepharness_csrf` cookie. State-changing browser requests must send `X-CSRF-Token` matching the CSRF cookie. Login attempts and authenticated writes are fixed-window rate limited; a `429` includes `Retry-After`.

For a Worker outage, existing events remain in PostgreSQL and commands stay queued. Check the Worker readiness endpoint, then inspect its ACP stderr tail in the session recovery surface. Do not attach a host Docker socket or run the Agent on the host as a workaround.
