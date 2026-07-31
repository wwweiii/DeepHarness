# Phase 8 Verification

Phase 8 adds durable Artifact, LSP, Web provenance, image-output, and optional
platform-profile surfaces while keeping the ACP boundary unchanged.

## Automated checks

The following checks are part of the Docker test profile:

```text
docker compose -f compose.yaml -f compose.test.yaml --profile verify run --rm test
```

The final verification on 2026-07-31 produced these results:

- TypeScript and UTF-8-safe diff checks: passed (`tsc --noEmit`,
  `git diff --check`).
- Contract suite: 43 passed, 0 failed, including the published Phase 8
  manifest/diff truth test.
- Unit suite: 46 passed, 0 failed, including Artifact, image, LSP parser, and
  outbound-network policy boundaries.
- Integration suites Phase 1 through Phase 8: all eight passed consecutively.
  The focused Phase 8 test passed 34 assertions against the real vendor ACP
  process, PostgreSQL, Gateway, and Worker.
- Playwright: all eight suites passed consecutively on the final run; Phase 8
  produced desktop and mobile screenshots and verified the real Artifact row.
- Capability audit: 389 capabilities, `unclassified=0`, 23 expected-failure
  gaps, 42 Phase 8 changes, no unreviewed additions, and no unapproved
  regressions.

The first broad regression run timed out once in the pre-existing Phase 6
stop/recovery timing path. A focused rerun passed in 34.6 seconds and the
subsequent complete Phase 1–8 sequence passed with Phase 6 in 34.3 seconds, so
the initial timeout is retained as a timing flake rather than a Phase 8
regression. Likewise, the first full Playwright run saw the Phase 2 approval
button hidden once; its focused rerun passed and the final complete run was
8/8 green.

The phase 8 contract covers the `0008_phase_8` migration, bounded artifact
path/size/MIME handling, image-output projection, LSP diagnostics and location
projection, Web source persistence, content-disposition/CSP download headers,
and the optional profile definitions. The focused unit suite also verifies
runtime tool-name aliases, traversal and symlink rejection, dangerous-MIME and
size limits, strict image input, vendor-formatted LSP locations, and the
outbound URL policy.

## Runtime conclusion

Artifacts emitted by ACP are registered with session and turn identity. Small
workspace files and image blocks are copied into the Gateway registry with a
digest and can be previewed or downloaded only through a session-scoped route.
Out-of-workspace paths, oversized files, and executable MIME types are rejected.

The optional LSP image contains `typescript-language-server` and a valid inline
plugin, but the locked ACP entry does not parse plugin arguments or initialize
the LSP manager. The profile and base image therefore both report a precise
blocked reason instead of presenting a false supported state; the profile test
preserves the failed ACP definition attempt. WebFetch and WebSearch source URLs are
shown with title/snippet provenance. The Chromium profile verifies that the
binary can be installed while the locked vendor build still reports
`WEB_BROWSER_TOOL compiled=false`; it is therefore an explicit expected
failure, not a supported Browser claim.

The isolated profile checks are:

```text
tests/integration/phase-8-lsp-profile.test.ts
tests/integration/phase-8-browser-profile.test.ts
```

The LSP check starts a real ACP session, attempts the definition scenario, and
asserts that no `lsp.location` is emitted while the precise ACP bootstrap
condition is visible. The Browser check starts the Chromium Worker image,
asserts that Chromium is detected, and still requires the compile-feature
blocker. These are passing expected-failure contracts, not successful LSP or
WebBrowser invocations.

Image input, WebBrowser in the locked build, SSH/Bridge/Direct Connect, voice,
desktop notification, and SCM/PR callbacks remain explicit expected failures
with evidence in
`docs/upstream/phase-8-platform-gaps.md` and `config/harness-capability-evidence.json`.
