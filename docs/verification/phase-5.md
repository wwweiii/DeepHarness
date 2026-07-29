# 阶段 5 验收记录：Commands、Skills、Plugins、Hooks 与 MCP

- 验收时间：2026-07-29 02:30 CST
- Vendor：`claude-code-best/claude-code` `v2.8.4-7-g987e5503`
- 锁定 commit：`987e55034c38497e1081367fdbe2056a6603ebc7`
- 结论：阶段 5 的 Commands、Skills、Plugins、Hooks、MCP registry、通用扩展 renderer、持久投影和 Docker 运行时验收通过。MCP 动态 tools、资源、认证和 local/local-jsx/TUI 命令仍按 ACP 实际边界保持红色 `expected_failure`，没有修改 vendor。

## 实现范围

- Protocol 增加 available command、extension snapshot、MCP status、refresh/toggle 命令和三类持久事件；数据库 migration 为 `0005_phase_5.sql`。
- Worker 从 user/project/local settings、`.claude/skills` 和 `.mcp.json` 发现扩展，逐源隔离错误；Plugins、Hooks、settings、Extra Tools 和 MCP 只投影脱敏状态。
- MCP 配置在送入 ACP 前按 ACP 0.19 schema 规范化：HTTP/SSE headers 为 `{name,value}[]`，stdio 的 `args/env` 为数组；无效 URL、缺少 command、未知 transport 被标为 error。凭据不写入 Gateway 事件或数据库。
- Worker 消费每个 ACP `available_commands_update`，Gateway 只按 live catalog 接受 callable prompt command，并通过 `/name args` 调用。local/local-jsx 命令在 Web 中显示明确阻塞原因。
- Web 提供 slash command palette、参数提示、Commands/Skills/Plugins/Hooks/MCP 视图、受控启停、审计和未知工具 generic renderer；MCP resources/auth 按 ACP 阻塞状态显示。
- 阶段 4 历史 diff 固定保存为 `artifacts/capabilities/vendor-capability-diff-phase-4.json`，phase 4 contract 不再读取阶段 5 当前 diff。
- 上游最小修复说明：`docs/upstream/phase-5-acp-extension-gaps.md`。

## 自动验收

最终源码版本在已启动的 Compose 栈中执行：

```text
typecheck                         passed
contract                          33 pass / 0 fail / 4396 assertions
unit                              25 pass / 0 fail / 115 assertions
phase 1 integration                1 pass / 0 fail / 10 assertions
phase 2 integration                1 pass / 0 fail / 149 assertions
phase 3 integration                1 pass / 0 fail / 52 assertions
phase 4 integration                1 pass / 0 fail / 35 assertions
phase 5 integration                1 pass / 0 fail / 18 assertions
Playwright phase 1-5              5 pass / 0 fail / 34.1s
git diff --check                   passed
```

phase 5 integration 使用真实 `ccb-bun --acp`，覆盖：

- project prompt command、`/statusline` 和 Skill command 的 catalog、参数提示、调用与 ACP turn 完成；
- `SkillTool` 生命周期、Skills source/condition/status、Plugins/Hooks source 和受控配置写入；
- `SearchExtraTools`/`ExecuteExtraTool` 状态和通用 renderer；
- MCP registry 脱敏、`mcpClients=[]` resources/auth 409/501 阻塞、OAuth credential 不持久化；
- session close、Worker cleanup 和事件/扩展快照重建。

### Capability 制品

- 389 项 capability，分类 `A=51`、`B=79`、`C=156`、`D=68`、`E=35`，`unclassified=0`。
- 12 个 known gaps 全部为 `expected_failure`。
- phase 5 的 7 项 `command.prompt.statusline`、`integration.hooks`、`integration.plugins`、`integration.skills`、`tool.ExecuteExtraTool`、`tool.SearchExtraToolsTool`、`tool.SkillTool` 均为 `tested=true`、`last_test_result=passed`、`ui_supported=true`。
- 当前发布 diff：7 changed、0 added、0 removed、0 regressions；`unreviewed_additions=[]`、`unapproved_regressions=[]`。Vendor commit 在本阶段未变化，Harness projection 变化仍进入 gated diff。

制品 SHA-256：

```text
vendor-capability-manifest.json       ce273505b89ddc7fca98c9869b4674ca07eb00dca80cd4976f2d52f9708d9d08
vendor-capability-diff.json           eeea0c9f944f52bb1bc02f72f449dac23ff94b13c02e34f6c16e8d210f56000e
vendor-capability-diff-phase-4.json   6fbf535e838d931a2f37ceebecefaa51929c871c54cb7997c2212c312942336f
vendor-acp-probe-report.json          d1f926cdf2fe63809b44ebd63e5ff5924e24f9294e90f486b7c66bbde0852675
vendor-static-audit-report.json       d30fc09c58f182f9e4395a1359abf64183ba2da2565eb32fdf6dc1d7da470516
harness-capability-evidence.json      809d2c608dee96bad202d515ab6829a32804c7a57d9fdbf0a69385fc9149e221
```

### Docker 与栈状态

- `docker compose -f compose.yaml -f compose.test.yaml build`：Gateway、Worker、test-model 成功构建；vendor builder 完成 1272 文件 ACP bundle。
- `docker compose -f compose.yaml -f compose.test.yaml --profile test up --build --detach --wait --force-recreate`：PostgreSQL、Gateway、Worker、test-model 全部 healthy。
- `docker compose ps` 最终状态：`gateway running healthy`、`postgres running healthy`、`test-model running healthy`、`worker running healthy`。
- Worker ready：`activeProcesses=0`、`queuedProcesses=0`、`dockerSocketMounted=false`、`agentBoundary=acp-stdio`。
- `docker compose top worker` 只有 init 与 `bun run apps/worker/src/main.ts`，没有 `ccb-bun --acp` 子进程。
- Gateway session 查询共 36 个历史 session，`open=0`，全部 `status=closed`、`processState=stopped`。

### 视觉验收

Playwright 断言桌面 `scrollWidth <= innerWidth`，移动端所有可见 extension 元素均在 `[0, viewportWidth]` 内，且 `pageerror=[]`。截图人工复核无重叠、截断或横向溢出：

- `output/playwright/phase-5-desktop.png`：1440x900，SHA-256 `1d1ecf187c3a61d42f5bbf9e24e651ca35e1df269b22389da9737e289b7981ec`。
- `output/playwright/phase-5-mobile.png`：390x844，SHA-256 `5cf84ac16811483f46fc058cb6eb7fdf8fb8e9418b131e568a65c39b6cc32fea`。

## ACP 与外部阻塞证据

以下能力未被伪装成 supported，均有 contract、源码/运行时证据和上游策略：

- `gap.acp.dynamic-mcp-tools`：vendor ACP 仍将 `mcpClients=[]` 传给 QueryEngine，MCP tools、resources 和 OAuth 不可达；Web 显示 blocked。
- `gap.acp.local-commands`：local/local-jsx/TUI 命令不是 ACP callable command，catalog 显示 `ACP blocked`。
- `gap.acp.command-hot-reload`：锁定 Agent 不会在 command/Skill 文件改变后动态刷新；UI 明示需要 session restart，等待上游通知语义。

首次执行完整测试镜像命令：

```text
docker compose -f compose.yaml -f compose.test.yaml --profile verify run --build --no-deps --rm test
```

BuildKit 在加载 `node:24.14.0-bookworm-slim` metadata 时返回 `not found`。Docker Hub API 同时确认该 tag 为 active，且现有 E2E 镜像的历史明确包含 `NODE_VERSION=24.14.0`。多个 Docker registry mirror 的 daemon pull 均无响应，按 OCI digest 的 pull 也被同一 mirror/proxy 链路阻塞；这属于外部 Docker Desktop registry 解析问题，不是项目构建或测试断言失败。

为完成不依赖该外部链路的代码验收，使用本机已缓存的 `deepharness-e2e` runtime（`node v24.14.0`、`Bun 1.3.13`、`Chromium 150.0.7871.181`）执行同一 test command，挂载当前源码和依赖。该 fallback 的完整 phase 1–5 矩阵全部通过；待 registry mirror 恢复后应重新执行上述 `--build` 命令作为发布前 clean-image gate。

## Vendor 边界

`vendor/claude-code` 工作树、staged diff 和外层 gitlink 均无修改；外层 gitlink、vendor lock、manifest 和 vendor HEAD 都是 `987e55034c38497e1081367fdbe2056a6603ebc7`。业务 Worker/Gateway 只通过 ACP stdio 调用 vendor。
