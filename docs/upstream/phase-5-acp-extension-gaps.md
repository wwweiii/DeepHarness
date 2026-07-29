# Phase 5 ACP extension gaps and minimal upstream fixes

DeepHarness keeps `vendor/claude-code` unchanged and reaches the Agent kernel only through ACP. The following fixes are intentionally described for upstream submission rather than applied to the submodule.

## Dynamic MCP clients

Observed contract:

- ACP `initialize` advertises HTTP and SSE MCP support.
- `session/new` accepts non-empty `mcpServers`.
- `src/services/acp/agent/createSessionMethod.ts` constructs `QueryEngine` with `mcpClients: []`.
- No MCP tool, resource, authentication request, or OAuth exchange becomes reachable in the session.

Minimal generic fix:

1. Validate ACP `mcpServers` against the transports advertised by `initialize`.
2. Connect them with the existing MCP client service before constructing `QueryEngine`.
3. Pass the connected clients and discovered tools into the engine instead of the empty array.
4. Attach cleanup to ACP close/cancel/process shutdown.
5. Emit connection, auth-required, resources-changed, tools-changed, and failure updates without placing credentials in notifications.
6. Isolate each server with `Promise.allSettled`; one invalid server must not abort the session.

The upstream acceptance contract should pass a deterministic HTTP MCP server to `session/new`, observe one dynamic tool and one resource, complete an auth challenge without logging the token, invoke the tool, read the resource, and verify cleanup on `session/close`.

## Command hot reload

Observed contract:

- ACP emits `available_commands_update` after opening/loading/resuming/forking a session.
- The session stores the command array loaded during creation.
- Project command, Skill, Plugin, and settings changes do not invalidate that array in the active `QueryEngine`.

Minimal generic fix:

1. Add an ACP command reload method, or subscribe session discovery to the vendor's existing settings/plugin filesystem invalidation.
2. Rebuild the session command array atomically.
3. Emit `available_commands_update` only after the new array is active for `session/prompt`.
4. Keep local/local-jsx commands excluded unless ACP gains explicit non-prompt command operations.

The upstream acceptance contract should create and remove a project prompt command during one active session, observe both catalog updates, successfully invoke the added command, and reject the removed command.

## Local and local-jsx commands

These commands depend on TUI/React process state and cannot be represented by sending their slash text as an ACP prompt. A generic upstream change needs typed command capabilities and invocation results, not a DeepHarness-specific bypass. Until that exists, the Web catalog displays their manifest source and precise ACP blocker and rejects invocation.
