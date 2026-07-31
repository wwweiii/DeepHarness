# Phase 6 verification

> Verified: 2026-07-31T01:42:50Z  
> Scope: Memory, Context, compact/checkpoint projection, advanced session lifecycle, data lifecycle boundaries  
> Vendor commit: `987e55034c38497e1081367fdbe2056a6603ebc7`

## Implemented surface

- Worker consumes ACP `usage_update`, invokes `session/list`, and records vendor compatibility metadata.
- Local Memory and Vault activity is normalized and redacted before entering ActivityTracker or leaving the Worker.
- Gateway persists content-free Memory observations and compact checkpoints and exposes `GET /api/sessions/:id/context`.
- Manual compact uses `/compact` through ACP `session/prompt`; structured metadata is reconciled from the vendor transcript with bounded retry.
- Context Inspector renders utilization, cache/usage fields, transcript checkpoints, Memory metadata, lifecycle boundaries, and real capability states.
- Resume/load/fork retain created, previous, and current vendor commit metadata.
- Routine capability audits compare against the published manifest in container `/tmp`; they cannot overwrite the published phase diff.

## Formal Docker gate

The locked test image built successfully, including `node:24.14.0-bookworm-slim` at digest `sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8`:

```sh
docker compose -f compose.yaml -f compose.test.yaml --profile verify build test
```

The repository-defined gate then passed without source bind-mount overrides:

```sh
docker compose -f compose.yaml -f compose.test.yaml --profile verify run --rm test
```

Results:

- TypeScript: `tsc --noEmit` passed.
- Contract: 36 passed, 0 failed, 4512 assertions.
- Unit: 32 passed, 0 failed, 148 assertions.
- Integration: phases 1-6 passed; Phase 6 passed 24 assertions.
- Playwright: 6 passed, including Phase 6 desktop and mobile Context Inspector coverage.
- `git diff --check`: passed.

## Capability gate

The locked audit image reports 389 capabilities: `A=49`, `B=81`, `C=155`, `D=69`, and `E=35`. `unclassified=0`; all 16 known gaps remain expected failures.

The Phase 6 diff is `compared` against the Phase 5 manifest and contains exactly these changed ids:

- `acp.listSessions`
- `command.local.compact`
- `feature.EXTRACT_MEMORIES`
- `feature.LODESTONE`
- `feature.PROMPT_CACHE_BREAK_DETECTION`
- `feature.TOKEN_BUDGET`
- `tool.LocalMemoryRecallTool`
- `tool.VaultHttpFetchTool`

`tool.VaultHttpFetchTool` is the sole `A -> D` regression and is explicitly approved with an exact id/from/to match. The release gate reports `unreviewed_additions=[]` and `unapproved_regressions=[]`.

Artifact SHA-256 values:

| Artifact | SHA-256 |
|---|---|
| `vendor-capability-manifest.json` | `42734b4b74a9a1c19ed4776b3be5f10a9c45a8c852b05a01038a7ba491a28f28` |
| `vendor-capability-diff.json` | `f4616d28fe71f0f0a2baabf28905c533c1d9bd2f1739a19b19360a46b99e46b2` |
| `vendor-acp-probe-report.json` | `9620c3fdf51bebad0c0c95c86fb97f1e46425d99acc130ac4cb29f824cbfcd31` |
| `vendor-static-audit-report.json` | `7841823a4138f193d0d701d50dd26ea4c9f03f615f8153d4814f51f1aaa32c07` |

## Acceptance evidence

- A Local Memory hit and a Vault missing-credential failure are both observed through real ACP tool execution. Result content, Vault key, query, fragment, reason, request body, response body, headers, and raw error text are excluded from control-plane events.
- Context utilization is sourced from ACP `usage_update`; prompt cache and token budget values remain explicit projections rather than inferred data.
- Manual compact creates a transcript-backed checkpoint, suppresses the fixed bridge text, and a subsequent prompt completes in the same session.
- Resume and load succeed after process stop; fork succeeds in an isolated worktree.
- A simulated prior vendor commit resumes successfully and is recorded as cross-version compatible.
- All test sessions are closed after the gate. Database checks report zero open sessions, pending permissions, active Agent process rows, and workspace locks.
- The latest Phase 6 browser session has zero persisted fixture-content or Vault-secret markers; every `memory_observations` row enforces `content_redacted=true`.
- Worker/Gateway/test-model logs contain no Phase 6 Memory fixture content or Vault secrets. Worker process inspection shows only container init and the Worker main process after cleanup.
- `vendor/claude-code` is clean at the locked commit and its gitlink is unchanged.

## Visual evidence

| Viewport | Artifact | SHA-256 |
|---|---|---|
| 1440x900 | `output/playwright/phase-6-desktop.png` | `cdebbc6706f0ace72e08d5006c3a4f6de7565dad233bd75164a7d1b4c6d9a4f6` |
| 390x844 | `output/playwright/phase-6-mobile.png` | `c1e2d20fce4080a5d5c32d9282f072e5eedfb92366808fb889cb1c5066ef15a9` |

Both images were inspected after the formal gate. The Context Inspector has no horizontal overflow, incoherent overlap, clipped controls, or page errors at either viewport.

## Expected failures

The following remain intentional and evidence-backed rather than being represented as supported:

- structured ACP Context inspection;
- rewind/checkpoint;
- structured ACP compact event;
- Memory extraction and Lodestone lifecycle status;
- credentialed Vault success in the base profile.

See `docs/upstream/phase-6-acp-context-gaps.md` for source evidence, current adapters, and removal conditions. No unresolved external build blocker remains for this verification run.
