# 阶段 4 验收记录：子 Agent、Task、Team 与 Coordinator

- 验收时间：2026-07-29 00:15 CST
- Vendor：`claude-code-best/claude-code` `v2.8.4-7-g987e5503`
- 锁定 commit：`987e55034c38497e1081367fdbe2056a6603ebc7`
- 结论：阶段 4 的 Agent、Task、Team、控制面、持久投影、Inspector、能力证据和 Docker 验收均通过。原生 coordinator、Agent triggers、ListPeers 和 in-process Team shutdown 等 vendor/ACP 限制保留为可复现 `expected_failure`，没有修改 vendor 或宣称不存在的原生能力。

## 实现范围

- 协议与 PostgreSQL 增加 Agent/Task/Team/peer/message/definition/limit 模型、事件、活动快照和停止命令；migration 为 `0004_phase_4.sql`。
- Gateway 提供活动查询及 Agent/Task stop API，持久化父子关系、输出、Team 路由、审计和终态；session close 会兜底终结仍活跃的 Agent、进程型 Task 和 peer。
- Worker 从 ACP tool lifecycle 和只读 vendor transcript/state 重建 Agent、Task 与 Team 投影，支持父子输出路由、后台 Agent、认证 `TaskStop`、Worker 重连 resync 和 session close 终态事件。
- 已验证内置 Explore、Plan、verification、general-purpose Agent 和项目自定义 Agent definition；子 Agent 深度、并发、token、peer、workspace 与 permission mode 均受配额检查。
- Task v2 在测试 Worker 中由 `CLAUDE_CODE_ENABLE_TASKS=1` 启用，并通过显式 child-env allowlist 传给 vendor。该变量是布尔功能开关，不是并发数；Agent/Team 配额由 `WORKER_MAX_SUBAGENTS_PER_SESSION` 等 Harness 配置控制。
- TaskCreate/Get/List/Update/Output/Stop、TeamCreate/Delete、SendMessage 和可达范围内的 ListPeers 均有领域投影与 Inspector。普通 pending Task 在 session close 后保留语义，只有进程型活动 Task 被停止。
- Web 提供桌面 Session Inspector 和移动 Activity 视图，可切换 Agents/Tasks/Teams，查看 definition、层级、输出、peer、消息、状态和配额，并停止可控后台 Agent/Task。

## 验收映射

| 计划验收项 | 证据与结果 |
|---|---|
| UI 可观察并停止多层子 Agent，输出不归错父消息 | Phase 4 integration 验证两层 Agent、parent id 和 child tool routing；Playwright 在桌面/移动 Inspector 中观察并停止后台 Agent；通过。 |
| Task 与 vendor 状态一致，Worker 重连可重建 | 真实 ACP 执行 TaskCreate/Get/List/Update/Output/Stop，读取 vendor task state，强制 Worker-Gateway reconnect 后重新投影；通过。 |
| Team/peer 消息有可靠 sender/recipient 和审计 | 真实 TeamCreate/Agent/SendMessage 流程断言 `team-lead -> builder`，Gateway 持久化 `team_messages` 与 stop audit；通过。 |
| coordinator 压力不超过资源限制 | Unit 连续观察 50 个 Agent 时只允许 3 个 active；integration 同时验证 depth、peer、token、workspace 与 process cleanup；通过。 |
| 子 Agent 不扩大父权限 | 已实现启动后保守检测、取消和审计；由于 ACP 没有原子 prelaunch policy hook，严格的启动前保证保留为 `gap.acp.subagent-prelaunch-policy`。 |
| Agent triggers 与原生 coordinator | 当前 ACP 不暴露两者的 local-jsx/REPL 入口，均保留 expected-failure；Harness 不以 Team UI 冒充原生 coordinator mode。 |

## 完整自动门禁

最终从空 PostgreSQL `tmpfs` 栈重建服务与测试镜像后执行：

```text
docker compose -f compose.yaml -f compose.test.yaml --profile test up --build --detach --wait --force-recreate
docker compose -f compose.yaml -f compose.test.yaml --profile verify run --build --no-deps --rm test
```

结果：

- `tsc --noEmit`：通过。
- Contract：29 pass / 0 fail / 4302 assertions。
- Unit：22 pass / 0 fail / 104 assertions。
- Phase 1 integration：1 pass / 0 fail / 10 assertions。
- Phase 2 integration：1 pass / 0 fail / 149 assertions，约 31.9s。
- Phase 3 integration：1 pass / 0 fail / 52 assertions，约 37.8s。
- Phase 4 integration：1 pass / 0 fail / 35 assertions，约 17.1s。
- Playwright E2E：Phase 1-4 共 4 pass / 0 fail，耗时 30.4s。
- `git diff --check`：通过。

Phase 4 integration 覆盖同步、内置、自定义、verification、嵌套与后台 Agent，Task v2 全工具族、Team/peer/message、TeamDelete 已知失败、stop control、Worker reconnect、session close 和数据库终态。Unit 另覆盖 50-Agent quota pressure、权限扩张检测、停止传播/失败恢复及 session-close replay。

## Capability 与锁定证据

正式 audit 使用保留的 Phase 3 manifest 作为 previous，并对实际 gitlink 重新执行静态 probe 和真实 `ccb-bun --acp` probe：

- 389 项 capability，`unclassified=0`。
- A=51、B=79、C=156、D=68、E=35。
- 11 个 known-gap contract，全部为 `expected_failure`。
- Phase 3→4 diff：28 changed、0 added、0 removed、0 regressions。
- `unreviewed_additions=[]`、`unapproved_regressions=[]`。
- Previous commit：`34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d`。
- Current commit：`987e55034c38497e1081367fdbe2056a6603ebc7`。

制品 SHA-256：

```text
phase-3 baseline manifest  f0c4ec0d39a3fb55811cb0b6b7ca87907db1c228bdbc3b96b566d92757b3b69e
phase-4 manifest           121941fdb07980c028d83d0eab8f80b77450624489c877b2bd86ac2840e99fa7
phase-4 diff               6fbf535e838d931a2f37ceebecefaa51929c871c54cb7997c2212c312942336f
```

Phase 2 的外层提交曾把 gitlink 从 `34b3dc9` 前移 7 个提交到 `987e550`，但 lock/manifest 未同步。本阶段审计确认该 vendor 差异只涉及 issue templates、contributors、cloud-artifacts `.gitignore` 和 perf-report 配置路径，随后将外层 lock、review、Compose 元数据和 capability 制品对齐到已提交 gitlink，并重跑完整门禁。最终以下四项一致：

```text
outer gitlink   987e55034c38497e1081367fdbe2056a6603ebc7
vendor HEAD     987e55034c38497e1081367fdbe2056a6603ebc7
vendor lock     987e55034c38497e1081367fdbe2056a6603ebc7
manifest        987e55034c38497e1081367fdbe2056a6603ebc7
```

`git diff -- vendor/claude-code`、vendor unstaged diff 和 vendor staged diff 均为空；DeepHarness 业务代码继续只经 ACP 调用 vendor。

## ACP 与 Vendor 阻塞证据

阶段 4 直接相关的六个 expected-failure：

- `gap.acp.tool-result-terminal-update`：ACP forwarding 跳过携带 `tool_result` 的 SDK user message；Harness 只能在持久化后从 transcript 恢复 terminal raw output，不能宣称原生 live terminal update。
- `gap.acp.subagent-prelaunch-policy`：自定义 Agent 可在 ACP 暴露 Harness 可确认的 policy point 前组装独立 tool pool；当前只能观察后取消，无法提供原子启动前权限约束。
- `gap.acp.coordinator-mode-activation`：vendor 编译 coordinator mode，但入口是 ACP 不发布的 local-jsx command，Web 无法进入原生 coordinator mode。
- `gap.build.list-peers-uds-inbox`：ListPeers 依赖未进入锁定默认 build 的 `UDS_INBOX`；真实 ACP 场景返回 not found，Harness 不生成虚假 peer。
- `gap.vendor.in-process-team-shutdown`：真实运行已观察到 teammate `shutdown_approved`，但 vendor 仍将该 in-process teammate 保持 active，随后 TeamDelete 返回 active-member failure。session close 会终结进程与 Harness 投影。
- `gap.acp.agent-triggers`：trigger 管理为 local-jsx command，调度 hook 依赖 REPL 生命周期；当前 ACP session 不暴露注册或触发事件。

其余五个继承 gap 为 image input、dynamic MCP tools、local/local-jsx commands、ACP agent version drift 和 AskUserQuestion updated input；均继续保留源码/运行时证据与 upstream strategy。

## 视觉验收

- `output/playwright/phase-4-desktop.png`：1440x900，SHA-256 `fcfe4163e58c1aee928cd2ef67c4855001ff9d0b4685e97d432a5c62f7389b21`。
- `output/playwright/phase-4-mobile.png`：390x844，SHA-256 `dd745a207c9ac85a877d31b4f5b3f85977068d58727b4c52eeb640f5a788e299`。

两张最终截图均人工复核。桌面 Inspector 与消息区无重叠；移动 Activity 使用全宽纵向布局，无页面级横向溢出；Agent counter 为 `0/3 active`，后台 Agent 明确显示 stopped。

## 进程与残留审计

最终门禁结束后：

```text
worker_vendor_commits=987e55034c38497e1081367fdbe2056a6603ebc7
live_agent_processes=0
open_sessions=0
active_agents_under_closed_sessions=0
active_process_tasks_under_closed_sessions=0
active_peers_under_closed_sessions=0
```

Gateway、Worker、PostgreSQL 和 test-model 均为 `healthy`。`docker compose top worker` 只显示 init 与 Worker 主 Bun 进程，没有 `ccb-bun --acp` 子进程。session close 的 Worker 终态事件、Gateway transaction backstop 和 Web replay fallback 共同防止历史关闭会话继续显示 running Agent。
