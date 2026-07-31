# Phase 9 Verification

The Phase 9 gate is satisfied only when the following evidence is attached to the release:

- `make audit` produces static and ACP probe reports, a manifest with `unclassified=0` and `ownerless=0`, and a diff with no unreviewed additions or unapproved regressions.
- `make capability-gate`, `make typecheck`, all contract/unit/integration tests, and the Playwright desktop/mobile suites pass in Docker.
- `make backup` creates a PostgreSQL custom dump and records Compose, DeepHarness, and vendor commits; `make restore-check BACKUP_DIR=...` restores it in an isolated project.
- Two consecutive runs of `make upgrade-check` produce a stable, reviewable diff. A failed upgrade is rolled back by image tag and submodule pointer, without editing vendor source.
- `/health/live`, `/health/ready`, `/metrics`, login, CSRF rejection, rate limiting, and structured request logs are checked from a running Compose stack.

The host-side Bun absence is expected: all required checks run in the `capability-audit`, `test`, and `e2e` containers. If the ACP provider or credentials are unavailable, retain the generated expected-failure report and mark the affected provider `not_tested`; do not call it supported.

## Recorded release evidence

The locked vendor commit is `987e55034c38497e1081367fdbe2056a6603ebc7`. The published manifest contains 389 capabilities with `unclassified=0`, `ownerless=0`, and `unexplained_untested=0`. The only six `not_tested` entries are credential-gated Bedrock, Foundry, Gemini, Grok, OpenAI-compatible, and Vertex profiles; `credential_blocked_untested=6` and none is enabled or labeled supported. The matrix distribution is A=43, B=82, C=160, D=69, E=35.

The current Docker audit produced the following passing results:

- capability gate: passed; all C entries carry an expected-failure/adapter result, concrete gap, and upstream strategy; all enabled A/B entries have a passed contract result;
- contract tests: 47 passed, 0 failed; unit tests: 53 passed, 0 failed; TypeScript typecheck: passed;
- integration tests: phases 1 through 8 passed through 8/8 configured `make integration-test` Docker runs;
- Playwright: all 9 desktop/mobile E2E specs passed, including the phase 9 health/metrics/capability/layout smoke;
- two consecutive `make upgrade-check` runs passed with the same vendor commit and `added=0`, `removed=0`, `changed=0`, `regressions=0`, and empty release-gate arrays;
- `/tmp/deepharness-phase9-backup-final` restored into an isolated Compose project and reported 42 restored PostgreSQL tables; the active volumes were not removed.

The auth-enabled Compose rehearsal also retained evidence for wrong-password `401`, login rate limiting (`401 401 401 401 401 429`), session/CSRF cookies, missing-CSRF `403`, and a CSRF-protected write `201`. The running test stack returned healthy `/health/live`, `/health/ready` (`database=ready`, `workerOnline=true`), Prometheus `/metrics`, and structured request logs with request IDs.

One external build limitation remains explicit: a fresh Playwright image rebuild requested `node:24.14.0-bookworm-slim` and the registry returned `not found`. No runtime version was changed to bypass it. The E2E suite was still executed against the already-built test image with the current `tests/` and `playwright.config.ts` mounted read-only; all nine specs passed. The ACP-known gaps remain expected and auditable: MCP clients are not attached by `createSession`, image prompt blocks are not delivered to the model, and local/local-jsx commands are not advertised.
