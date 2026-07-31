# Phase 7 ACP gaps

The locked vendor build contains Goal, Workflow, Cron/Kairos, Monitor, Sleep, and Agent trigger implementations, but the ACP session surface does not expose all of their terminal entry points as prompt commands. In particular, trigger registration is a `local-jsx` command and local scheduling is mounted by a REPL hook. The Harness therefore owns durable scheduling and sends ordinary ACP prompts through the existing Worker boundary.

The dynamic ACP probe was attempted in the Docker audit profile. It stopped at `packages/vendor-capabilities/src/acpProbe.ts:179` with `ACP prompt did not stream expected text: Not logged in · Please run /login`. No dynamic capability manifest was accepted from that run, and the locked vendor submodule was left unchanged.

The external compatibility contract is intentionally explicit:

- `advertised_by_acp=false` for vendor local/local-jsx commands.
- The Harness scheduler persists intent, timezone, misfire policy, next run, heartbeat, and cursor before dispatch.
- Goal completion requires evidence; a continuation limit becomes a blocked audit rather than a successful completion.
- Vendor ACP changes that expose structured Goal/Workflow/Cron lifecycle events can replace the adapter, but no vendor source change is required for the current profile.
- RemoteTrigger remains an explicit `501` until an authenticated callback/provider profile and ACP-visible registration/acknowledgement contract exist.
