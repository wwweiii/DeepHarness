# Phase 6 ACP Memory and Context gaps

Baseline: locked `vendor/claude-code` commit `987e55034c38497e1081367fdbe2056a6603ebc7`. DeepHarness does not modify vendor source and uses only ACP stdio at runtime.

## Structured Context inspection

ACP emits `usage_update` with `used` and `size`, which is sufficient for context-window utilization. It does not expose the vendor's structured Context analysis. `CtxInspectTool` is gated by `CONTEXT_COLLAPSE`, and that feature is not compiled in the locked default build.

Expected failure: `tool.CtxInspectTool` and `feature.CONTEXT_COLLAPSE` remain disabled and are rendered as such in the Context Inspector.

Current adapter: project `usage_update` plus content-free transcript counts. No substitute inspection control is presented.

Upstream path: add a read-only ACP Context inspection method that returns token categories and feature status without transcript content.

## Compact metadata

`command.local.compact` has `supportsNonInteractive=true`, so DeepHarness can send `/compact` through ordinary ACP `session/prompt`. The ACP forwarding bridge reduces the resulting boundary to the fixed assistant text `Compacting completed.` and omits the boundary id, trigger, pre-compact tokens and summarized-message count.

Expected failure: ACP never produces a structured compact notification in the locked build.

Current adapter: suppress the fixed bridge text, parse only `compactMetadata` from the vendor JSONL transcript, emit `context.compacted` with `source=vendor_transcript_metadata`, and retain the transcript as the recovery source of truth. A bounded retry handles transcript write latency.

Upstream path: add a structured ACP compact notification with boundary id, trigger, `preTokens`, `messagesSummarized` and completion status. Once available, transcript reconciliation can be removed.

## Rewind and checkpoint

`/rewind`, also exposed as `/checkpoint`, is a local command with `supportsNonInteractive=false`. It requires the vendor interactive UI to select a message and preview effects. ACP has no equivalent session operation.

Expected failure: the Context API reports rewind/checkpoint as blocked and the Web UI exposes no callable control.

Current adapter: none. Sending a visually similar prompt or implementing database-only rewind would not alter vendor model context and would be misleading.

Upstream path: add an ACP operation with target message identity, diff preview, confirmation, branch semantics and a structured result.

## Memory extraction and Lodestone status

`EXTRACT_MEMORIES` and `LODESTONE` are compiled in the locked build and run in vendor housekeeping. ACP has no dedicated schedule, success, failure, affected-store or anchor status events. `TEAMMEM` is not compiled.

Expected failure: extraction/Lodestone status cannot be observed beyond build capability and generic session health.

Current adapter: label both features `kernel_managed`, show the exact evidence-backed reason, and project only explicit `LocalMemoryRecall` and `VaultHttpFetch` tool activity. No Memory content is inferred from housekeeping.

Upstream path: emit privacy-preserving ACP housekeeping lifecycle events with status and source identifiers but no Memory content.

## Vault runtime conditions

`VaultHttpFetch` is ACP tool-reachable, but successful execution requires a configured vendor Vault key and outbound HTTPS access. It is therefore matrix class `D`, not an unconditional native capability.

The base Docker test profile verifies the missing-credential failure path and redaction. A credentialed optional profile is required before a specific Vault/endpoint combination can be marked successful.

## Disabled related features

`HISTORY_SNIP`, `CONTEXT_COLLAPSE` and `TEAMMEM` are not compiled in the locked default build. Similar UI is not used to imply support. Their manifest entries remain `C` with `compiled=false`, and any future enablement requires a new vendor build review and ACP contract test.
