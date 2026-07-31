# Data lifecycle boundaries

> Applies to Phase 6 and later. DeepHarness remains a private, single-operator Harness, but privacy and deletion boundaries are explicit rather than implied.

## Ownership matrix

| Data class | Source of truth | PostgreSQL content | Backup consistency set | Delete boundary |
|---|---|---|---|---|
| Memory | Vendor-owned Agent state under `/home/agent/.claude`, including Local Memory and Vault metadata | Tool name, source type/label, operation, hit/count/bytes, status and normalized error only; `content_redacted=true` is enforced | Back up the `agent-state` volume when cross-session Memory continuity is required | Delete the vendor Memory entry or Vault key first, then remove the Harness session projection if its audit metadata must also disappear |
| transcript | Vendor JSONL in the `agent-state` volume | Session-to-Agent id, compact boundary metadata, usage and recovery events; no reconstructed model context | Back up `agent-state` together with the database vendor commit fields | Use a vendor session/transcript deletion operation; deleting database rows alone does not erase model context |
| artifact | Workspace bytes or a future dedicated artifact volume | Registry metadata only | Back up artifact bytes and their registry rows as one set | Remove workspace-bounded bytes before deleting the registry row; database deletion alone does not remove files |
| database event | PostgreSQL control-plane event log | Full normalized Harness event, except Memory inputs/results are redacted before insertion | Use a PostgreSQL-consistent backup | Deleting a Harness session cascades events, approvals, Memory observations and checkpoints, but not vendor transcripts or workspace files |

## Retention

DeepHarness does not apply an implicit time-based retention policy in Phase 6. Session control-plane data and the Agent state volume remain until the operator invokes an explicit deletion workflow or removes the deployment volumes. This avoids silently breaking resume/load/fork.

The following fields are metadata, not Memory content:

- Local Memory store and key identify the source selected by the Agent.
- Vault endpoints retain only origin and path. Query strings and fragments are removed.
- Vault key names are stored only as a non-cryptographic fingerprint used for correlation.
- Results retain hit, item count, UTF-8 byte count, truncation, HTTP status and a normalized error code.

Request bodies, Vault reasons, authorization schemes, header names, response headers, result bodies, Memory values and raw error text are excluded from Memory-specific events. A model can still quote user-visible Memory in its ordinary assistant reply; that reply follows the transcript and database-event policies, not the Memory metadata policy.

## Backup and restore

For a resumable backup:

1. Quiesce new session commands.
2. Take a PostgreSQL-consistent backup.
3. Snapshot `agent-state` and any artifact bytes before accepting new prompts.
4. Record the Worker `vendor_commit` and image digest with the backup.

On restore, start the locked vendor build recorded with the backup. If a different vendor commit is intentionally used, DeepHarness records `created_vendor_commit`, the previous `last_vendor_commit`, and the current commit. A successful ACP load/resume is reported as cross-version compatible; a failed restore enters `recovery_required` with its transcript classification.

Restoring PostgreSQL without `agent-state` preserves audit history but cannot restore model context. Restoring `agent-state` without PostgreSQL leaves vendor transcripts that are not addressable through the Harness session catalog.

## Deletion procedures

Session deletion and session close are different operations. Close terminates the Agent process and releases workspace locks; it intentionally retains all durable state for recovery and audit.

For complete operator-requested deletion:

1. Close the Harness session and wait for the Agent process to stop.
2. Delete associated vendor transcript and Memory data using vendor-owned operations or a volume-level maintenance procedure.
3. Remove artifact bytes within their validated workspace roots.
4. Delete the Harness session row; database foreign keys cascade the control-plane projection.
5. Verify backups are expired or rotated according to the operator's backup policy.

DeepHarness does not expose this destructive workflow as a Phase 6 Web button because ACP lacks a complete transcript/Memory deletion contract. The absence of a button must not be interpreted as deletion having occurred.
