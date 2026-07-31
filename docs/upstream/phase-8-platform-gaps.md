# Phase 8 Platform and ACP Gaps

This document records the capabilities that remain intentionally blocked in the
base Docker profile. The Web control plane exposes the state and evidence; it
does not claim that a host runtime or an ACP-adjacent TTY feature is available.

## Image input

The locked vendor ACP advertises image output conversion, but the prompt
conversion path does not pass `image` content blocks into the model query. The
image input picker therefore remains disabled. The expected-failure evidence is the
vendor ACP prompt conversion test and the `acp.prompt.image` capability entry.
Image output is supported through the Harness artifact registry when ACP emits
an image content block.

## Optional profiles

`compose.platforms.yaml` provides separate `lsp` and `browser` profiles. The
base Worker has no language server or Chromium dependency. The LSP profile sets
`ENABLE_LSP_TOOL=1`, installs `typescript-language-server`, and mounts the
inline `.lsp.json` plugin configuration that the vendor LSP manager requires;
however, the locked `--acp` fast path only activates when `--acp` is the first
argument, does not parse `--plugin-dir`, and does not call
`initializeLspServerManager()`. The profile therefore starts normally but
reports LSP as blocked, and its expected-failure ACP invocation is tested
separately. The browser profile sets
`WEB_BROWSER_PROFILE=chromium` and installs Chromium, but the locked vendor
manifest has `WEB_BROWSER_TOOL` compiled=false. Chromium therefore remains a
runtime dependency probe and the platform record stays blocked until a vendor
build with that feature is supplied. Only one Worker profile should register
with a Gateway at a time.

## Vendor tool truth table

- `TerminalCaptureTool`: blocked because `TERMINAL_PANEL` is compiled=false and
  the Harness ACP initialize request advertises `clientCapabilities.terminal=false`.
- `PowerShellTool`: Windows-only; the Linux Worker has no PowerShell boundary.
- `SnipTool`: `HISTORY_SNIP` is compiled=false and Snip is a Context operation,
  not a file Artifact transport.
- `SendUserFileTool`: adapter aliases are present, but vendor Bridge is disabled
  in the standard ACP session, so it is not claimed as an upload integration.
- `ReviewArtifactTool`: `REVIEW_ARTIFACT` is compiled=false in the locked build.
- `WebBrowserTool`: a Chromium binary cannot restore a tool removed at compile
  time; the browser profile's blocked condition is an explicit expected failure.
- `LSPTool`: the binary and inline plugin are present in the optional profile,
  but the locked ACP entry cannot load the plugin or initialize the manager;
  adding `--plugin-dir` before `--acp` produces `unknown option '--acp'`, while
  adding it after `--acp` is ignored by the ACP fast path.

## Outbound network policy

`OUTBOUND_NETWORK_POLICY` supports `deny`, `public-web` (the default), and
`allowlist`, with `OUTBOUND_NETWORK_ALLOWLIST` providing exact hosts or `*.`
suffix entries. WebFetch/WebSearch/WebBrowser permission requests are denied
before execution when the policy rejects them. Literal loopback, RFC1918,
link-local, IPv6 ULA/link-local, Docker control-plane names, `.local`, and
`.internal` targets are blocked. This is an application-layer URL guard, not a
complete firewall: DNS rebinding, proxy behavior, and other container-network
paths still require Docker/network egress controls.

## SSH, Bridge, voice, and external integrations

SSH remote execution, Bridge/Direct Connect, voice, desktop notifications, SCM
and PR callbacks require host credentials, an external callback, or a TTY
transport that is outside the ACP stdio contract. They are represented as
blocked or not-tested platform integrations. No Docker Socket, host language
runtime, host browser, SSH agent, or external credential is mounted by the base
stack.

The concrete expected-failure IDs are `gap.platform.ssh-remote`,
`gap.platform.bridge-direct-connect`, `gap.platform.voice`, and
`gap.platform.notifications-scm`. A future profile may replace an individual
gap only after it has an authenticated contract test and a matching manifest
diff.
