# Installation

DeepHarness is operated as a private Docker Compose stack. The host needs Docker Desktop (or Docker Engine with Compose v2) and the code directory that will be mounted into the Worker. Bun, Node.js, Python, PostgreSQL, a browser, and language servers are supplied by the images and are not host prerequisites.

1. Copy `.env.example` to a private `.env` and set one provider credential. For a real deployment set `AUTH_ENABLED=1`, a unique `WORKER_SHARED_TOKEN`, `POSTGRES_PASSWORD`, and an `ADMIN_PASSWORD` of at least 12 characters. Keep `.env` outside source control.
2. Run `docker compose config` and confirm that only the intended workspace is mounted at `HOST_WORKSPACE_PATH`.
3. Run `make compose-up`. The stack is ready when `GET /health/ready` and `GET /health/ready` on the Worker both return HTTP 200.
4. Open `http://127.0.0.1:${GATEWAY_PORT:-8080}` and sign in when authentication is enabled.

The test profile is isolated from the normal PostgreSQL volume. Use `make compose-up-test`, `make integration-test`, and `make e2e-test` for a deterministic fake provider run. Stop only the services started for the task with `docker compose down --remove-orphans`; do not use `down -v` on a deployment that contains user data.

## Optional profiles

`compose.platforms.yaml` adds the LSP and Chromium Worker images. `compose.providers.yaml` exposes credential-gated provider smoke profiles. Optional profiles are opt-in and their capability status remains `D` or `not_tested` until the profile's contract test passes.
