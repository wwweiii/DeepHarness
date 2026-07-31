# Capability Matrix

The generated manifest in `artifacts/capabilities/vendor-capability-manifest.json` is the only status source for the Gateway, CI artifacts, and the Web Capability page. Each entry has a stable id, kind, owner, source/runtime evidence, conditions, matrix class, six-dimensional runtime state, and the latest test result.

| Class | Meaning | Required evidence |
|---|---|---|
| A | Native ACP inheritance | ACP contract test and passed invocation |
| B | Harness adaptation | ACP or vendor test plus protocol, persistence, and UI evidence |
| C | ACP gap | Reproducible expected failure, source/runtime evidence, UI block, and upstream strategy |
| D | Docker/platform dependency | Optional profile, enablement conditions, and profile test or explicit not-tested status |
| E | Non-Agent core | Non-core rationale and source evidence; excluded from production navigation |

`unclassified=0`, `ownerless=0`, and `unexplained_untested=0` are release gates. Every enabled A/B entry must have a passed contract result even when the protocol does not expose an invocable flag. C entries must have a tested expected failure (or a tested adapter result), a concrete gap, and an upstream strategy. D entries must have an enablement condition and a tested profile result or an explicit base-profile degradation. E entries are closed by their non-core rationale. The only allowed `not_tested` entries are credential-blocked provider profiles; they are never shown as supported. The diff records additions, removals, field changes, regressions, and exact approvals. The CLI gate rejects unreviewed additions, unapproved A/B to C/D/E transitions, and missing matrix closure evidence.

Known ACP gaps are intentionally visible: MCP clients are not attached by the locked vendor `createSession`, image prompt blocks are not delivered to the model, and local/local-jsx TUI commands are not advertised. DeepHarness does not modify `vendor/claude-code` to hide these gaps.
