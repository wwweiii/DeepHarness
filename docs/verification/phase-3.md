# 阶段 3 验收记录：持久化、恢复、工作区与并发

- 验收时间：2026-07-28 18:46 CST
- DeepHarness 阶段提交：`45bc67685c17bccfc19dddf88d45fefbc3042e6a`
- 运行时 Vendor：`claude-code-best/claude-code` `v2.8.4-7-g987e5503`
- 运行时 vendor gitlink：`987e55034c38497e1081367fdbe2056a6603ebc7`
- Phase 3 capability baseline：`v2.8.4`，vendor commit `34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d`
- 结论：阶段 3 的持久化、恢复、工作区、并发、清理、UI 和 Docker 验收均通过。Phase 3 当时保留的 vendor lock/manifest 基线与外层 gitlink 不一致，已在阶段 4 审计中对齐；该元数据问题不影响本阶段运行时验收结果。

## 实现范围

- `packages/database/migrations/0003_phase_3.sql` 增加 session context/recovery/process/worktree 字段、command delivery 状态、workspace locks 和 agent processes，并清理已关闭 session 的孤儿锁。
- Gateway 持久化 command ACK/retry、idempotency key、事件幂等追加、seq 分配、SSE replay 和历史分页；Worker 重连时重新入队未 ACK command。
- Worker 通过 ACP 实现 `session/resume`、`session/load`、`session/fork` 和 `session/close`，保存 context snapshot，并对缺失、损坏、空 transcript 产生明确的 `TRANSCRIPT_MISSING`、`TRANSCRIPT_CORRUPT`、`TRANSCRIPT_EMPTY` 状态。
- 每个 session 使用独立 Agent 进程；Supervisor 实现 idle TTL、最大并发、启动队列、重复 command 去重、崩溃隔离、优雅退出和超时后的强制终止。
- Workspace 支持 Git Shared、非 Git Shared 和 Git worktree；Shared workspace 使用写锁，worktree 关闭时清理干净目录，脏 worktree 保留并发出状态事件，异常 staging 目录启动时清理。
- Web 支持 durable session 切换、刷新后历史恢复、process/recovery/workspace Inspector、resume/load/fork 操作和 transcript 错误诊断；恢复错误不会被 reducer 丢失。

## 完整自动门禁

Phase 3 使用 Docker Compose test profile 完成验收，测试服务使用 Docker 内的 Node 24 与 Chromium；宿主机不需要 Bun、Node、Python 或浏览器运行时。

```text
docker compose -f compose.yaml -f compose.test.yaml run --rm test
```

结果：

- TypeScript：通过。
- Contract：24 pass / 0 fail。
- Unit：12 pass / 0 fail。
- Phase 1 integration：通过。
- Phase 2 integration：通过。
- Phase 3 integration：1 pass / 0 fail / 52 assertions。
- Playwright E2E：3 pass / 0 fail；Phase 3 standalone Docker Playwright 约 13.3s。

额外执行的 Compose 门禁：

```text
docker compose build
docker compose up -d
docker compose config --quiet
docker compose ps --format json
```

基础镜像构建、Compose 配置校验和服务启动均通过；Gateway、PostgreSQL、Worker 和 test-model 均为 `healthy`。

## 验收映射

| 计划验收项 | 证据与结果 |
|---|---|
| migration、command ACK/retry、事件幂等、SSE replay、历史分页 | `tests/integration/phase-3-stack.test.ts` 验证历史分页游标、并发 seq 连续性、重复 event 只插入一次、超时 command retry 后 ACK，以及所有 command 进入 `acked/failed` 终态；通过。 |
| ACP resume/load/fork、transcript 检测、context snapshot | `tests/integration/phase-3-stack.test.ts` 验证 `load`、`resume`、真实 fork、`TRANSCRIPT_CORRUPT`、`TRANSCRIPT_MISSING` 和 context state；`tests/unit/transcript.test.ts` 覆盖 missing/corrupt/empty/valid；通过。 |
| 每 session 独立进程、idle TTL、并发、队列和回收 | 两个 workspace session 并行运行；第三个 session 在 `maxConcurrency=2` 时进入队列，释放进程后自动启动；关闭排队 session 会生成 `closed_while_queued`；通过。 |
| Shared 锁、Git worktree、非 Git Shared | Git Shared 同路径别名和只读别名均在占用时返回 409；非 Git Shared 可运行；Git worktree 使用 `/workspace/runs/<sessionId>`，关闭时清理干净 worktree；通过。 |
| CPU、内存、PID、超时和异常清理 | Worker Compose 配置包含 `mem_limit`、`cpus`、`pids_limit`、read-only rootfs、`init` 和 stop grace period；ACP/Git 操作有 timeout；Worker 启动清理 abandoned worktree staging；通过。 |
| Gateway、Worker、浏览器重启恢复 | 真实 Gateway/Worker restart evidence 见下节；Playwright 覆盖刷新、新页面恢复历史和 recovery banner；通过。 |
| Agent 崩溃隔离、Worker 退出无子进程 | 一个 Agent crash 后另一个 session 保持 running 并完成新 turn；Worker 停止后 `activeProcesses=0`、`queuedProcesses=0`，`docker compose top worker` 仅剩 init 与 Worker 主进程；通过。 |
| resume/load/fork/compact capability | `tests/contract/capabilities/phase-3-recovery.test.ts` 验证 ACP boundary、transcript 错误和六个 Phase 3 recovery capability evidence；`compact` 明确标为 `vendor_managed`、`acpMethod=null`，不伪造 ACP 原生接口；通过。 |

## 真实重启证据

### Gateway restart

一个真实 `idle/running` session 在完成 prompt 后执行：

```text
docker compose -f compose.yaml -f compose.test.yaml restart gateway
```

重启后通过 Gateway API 核对：

```json
{
  "sessionId": "2209c315-98b2-4a98-b607-3d0cd3742e3e",
  "status": "idle",
  "processState": "running",
  "lastEventSeq": 25,
  "returnedEvents": 25,
  "historyExact": true,
  "promptRestored": true,
  "workerOnline": true
}
```

会话随后正常关闭，未留下 workspace lock 或 Agent process。

### Worker restart

另一个真实 session 在 Worker 重启前保存了 24 个事件 ID，然后执行：

```text
docker compose -f compose.yaml -f compose.test.yaml restart worker
```

重启后核对结果：

```json
{
  "sessionId": "7f1a7703-53f7-4771-9220-75b93b317dad",
  "agentSessionId": "29a72f2c-fbee-4520-817d-c5d528f4e4d6",
  "persistedHistoryExact": true,
  "recoveryEvent": {
    "status": "ready",
    "strategy": "resume",
    "seq": 36
  },
  "turnCompletedSeq": 52,
  "lastEventSeq": 53,
  "sameAgentSessionId": true,
  "workerOnline": true
}
```

关闭恢复 session 后，Worker health 返回 `activeProcesses=0`、`queuedProcesses=0`；`docker compose top worker` 只显示 init 和 `bun run apps/worker/src/main.ts`，没有 `ccb-bun --acp` 子进程。

## Capability 与发布证据

Phase 3 manifest：

- 389 项 capability，`unclassified=0`。
- A=51、B=79、C=156、D=68、E=35。
- 6 个 Phase 3 recovery entries：`acp.loadSession`、`acp.unstable_resumeSession`、`acp.unstable_forkSession` 及对应的 `advertised` capability，均有 integration/runtime evidence。
- Phase 3 capability diff：6 changed、0 added、0 removed、0 regressions；`unreviewed_additions=[]`、`unapproved_regressions=[]`。
- manifest SHA-256：`f0c4ec0d39a3fb55811cb0b6b7ca87907db1c228bdbc3b96b566d92757b3b69e`。
- capability diff SHA-256：`eab617497f9b1feb028c594fe0904c7d5a65fe563f51e4d071abb7ef76185877`。

业务代码继续只通过 ACP 调用 vendor；未修改 `vendor/claude-code` 内容。阶段 3 相关 ACP 缺口继续以可复现证据和明确降级状态记录，没有伪装成原生支持。

## 视觉验收

- `output/playwright/phase-3-desktop.png`：1280x720，SHA-256 `8285dea3e8dc4b6326584d1c4ea734f38671795ed2fca538dc24752834539b29`。
- `output/playwright/phase-3-mobile.png`：390x844，SHA-256 `a9a1da01d2ec526547819b7c6901839a4958922585c46c4f580eb1063d79f915`。

两张截图人工复核均非空白，显示完整 `TRANSCRIPT_CORRUPT` recovery diagnostic；移动视口没有页面级横向溢出，主要区域边界均在 viewport 内。

## 最终残留审计

```text
worker_active_processes=0
worker_queued_processes=0
open_sessions=0
docker_socket_mounted=false
vendor_worktree_modified=false
```

最终 `git diff --check`、Compose config 校验和服务 health check 均通过。
