# 阶段 1 验收记录：最小垂直链路

- 初始验收时间：2026-07-28 03:50 CST
- 真实 Provider 复验时间：2026-07-28 10:23 CST
- Vendor：`claude-code-best/claude-code` `v2.8.4`
- 锁定 commit：`34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d`
- 结论：阶段 1 的实现、隔离测试链路和真实 Anthropic 协议 Provider smoke 均通过。

## 实现范围

- Worker 在独立 `ccb-bun --acp` 子进程中完成 `initialize`、`session/new`、`session/prompt`、`session/cancel`，并隔离 stdout 协议和 stderr 日志。
- Gateway 提供单活跃 session API、Worker WebSocket 注册、PostgreSQL 事件持久化、SSE 历史 replay 和 seq 幂等。
- Web 使用 assistant-ui External Store Runtime，支持文本、reasoning、运行状态、错误、取消和刷新后的历史恢复。
- Compose 提供 Gateway、Worker、PostgreSQL、隔离 Anthropic 协议测试模型和 Chromium E2E profile；Worker workspace 挂载为 `/workspace/source`，容器不挂载 Docker Socket。

## 通过的自动检查

以下命令在 Docker 内完成：

```text
make audit
make typecheck
make contract-test
make unit-test
```

结果：

- capability audit：389 项，`unclassified=0`；A=51、B=79、C=156、D=68、E=35；4 个 ACP gap 均为可复现 `expected_failure`。
- contract tests：12 pass / 0 fail / 3715 assertions。
- unit tests：2 pass / 0 fail / 9 assertions。
- typecheck：`tsc --noEmit` 通过。

干净 PostgreSQL tmpfs 栈使用以下命令启动：

```text
docker compose -f compose.yaml -f compose.test.yaml --profile test up --detach --wait --force-recreate --no-build
```

最终状态：PostgreSQL、Gateway、Worker、test-model 均为 `healthy`。干净栈上的 HTTP 集成测试：

```text
make integration-test
```

结果：1 pass / 0 fail / 10 assertions，覆盖流式文本、workspace marker、取消、历史 replay 和 seq 唯一性。

标准 E2E 入口会先强制重建并等待隔离测试栈健康，再运行 Chromium：

```text
make e2e-test
```

结果：1 pass（5.1s）。覆盖创建 session、Connected 状态、流式回复、停止、刷新历史、桌面/移动视口和移动端无横向溢出；取消后及刷新后均不残留 Stop 操作。截图制品：

- `output/playwright/phase-1-desktop.png`
- `output/playwright/phase-1-mobile.png`
- `output/playwright/phase-1-real-provider.png`

完整阶段门禁 `make verify` 最终通过；其中标准 E2E 为 1 pass（4.6s），测试栈四个服务均为 `healthy`。

## ACP 运行证据

`make audit` 使用正式 vendor `ccb-bun --acp`，并通过隔离 test-model 的 Anthropic `/v1/messages` SSE 响应完成真实 ACP 请求：

- `session/prompt` 返回 `end_turn`，观察到 7 个 `agent_message_chunk` 文本更新，文本包含 `STREAM OK`。
- 慢流收到 `session/cancel`，返回 `stopReason=cancelled`，取消前观察到流式更新。
- stdout 协议错误为 0；stderr 只作为独立日志流收集。
- manifest 中 `acp.prompt`、`acp.cancel`、`acp.sessionUpdate.text` 均为 `tested=true`、`last_test_result=passed`，并标记 UI 支持。

HTTP/浏览器 workspace 读取结果包含：

```text
DEEPHARNESS_PHASE_1_WORKSPACE_READ_OK
```

## 真实 Provider 复验

复验只检查 `.env` 中 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL` 已设置，不打印或写入任何实际值。使用独立 Compose project `deepharness-real-smoke`、独立 PostgreSQL volume 和宿主端口 `18081`，未覆盖隔离测试栈。

- PostgreSQL、Gateway、Worker 均为 `healthy`；ACP `session/new` 成功，协商模型为 `deepseek-v4-flash`。
- 低成本文本 prompt 返回精确文本 `DEEPHARNESS_REAL_PROVIDER_OK`，包含 12 个 `assistant.text_delta`，最终 `stopReason=end_turn`。
- workspace prompt 通过 Agent 文件工具读取 `/workspace/source/phase-1-marker.txt`，包含 18 个文本增量并返回 `DEEPHARNESS_PHASE_1_WORKSPACE_READ_OK`。
- 运行中 prompt 收到 cancel 后产生 `session.interrupted(reason=user_cancelled)`，最终 `stopReason=cancelled`，session 恢复 `idle`。
- Playwright CLI 从浏览器填写并提交 prompt，返回 11 个文本增量和精确文本 `BROWSER_REAL_PROVIDER_OK`；刷新页面后历史、模型和 `idle` 状态均恢复。
- Gateway 强制重建后 Worker 自动重连，148 个既有事件可 replay；真实 Provider 全程 4 个 turn 均完成，`turn.failed=0`，非用户取消的 `session.interrupted=0`。
- 最终页面截图为 `output/playwright/phase-1-real-provider.png`，页面显示 `Connected`、真实 Provider 回复、workspace marker、模型和可继续输入的 composer。

## 容器边界

- vendor submodule 工作树为空，HEAD 与锁定 commit 一致。
- Gateway、Worker、test-model 使用 read-only rootfs、`cap_drop: ALL`；Worker 以非 root `agent` 用户运行。
- Compose 和实际服务 mounts 均不包含 `/var/run/docker.sock`。
- Worker 只向 Gateway 建立认证 WebSocket，浏览器不直接连接 ACP stdio。

## 已知 ACP 缺口

- ACP 已知缺口保持预期失败：图片输入、动态 MCP tools、local/local-jsx commands、ACP agent version drift；均未修改 vendor 绕过。
