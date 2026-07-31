# 阶段 7 验证：Goal、Workflow、Cron 与 Background Sessions

## 结论

阶段 7 的 Harness 控制面已经实现并通过容器内 TypeScript、固定时钟单元测试和 PostgreSQL/Gateway API smoke 验证。长任务状态保存在 PostgreSQL，不依赖浏览器连接或 SSE subscriber；Worker 仍只通过 ACP 接触 vendor。

## 已验证行为

| 范围 | 证据 |
|---|---|
| Goal 创建与幂等 intent | `goals`、`background_jobs`、`background_job_intents` 在 `0007_phase_7` 中持久化；重复 `Idempotency-Key` 不新建任务 |
| Goal 完成门禁 | `POST /api/goals/:id/complete` 没有非空 evidence 返回 `422`; evidence 写入 `completion_evidence` 后才进入 `completed` |
| Goal 阻塞审计 | `POST /api/goals/:id/block` 要求非空 audit；continuation 超过上限自动写入 `blocked_audit` 并停止续跑 |
| Workflow | `.claude/workflows` 由 Worker 在挂载工作区内发现并通过 `workflow.created` 投影；Markdown/text/JSON/YAML 定义、run、步骤 attempt、retry、cancel 都有独立行，定义 ID 按来源路径稳定为 UUID |
| Cron/Kairos 替代调度 | `@every`、`@once` 和五字段 cron 支持显式 IANA timezone；`run_once`、`skip`、`run_all` 与 catch-up 上限由固定时钟函数验证，实际首次和后续时间均使用同一计算器 |
| Brief/Away/Sleep/Monitor | `/api/background-jobs` 提供受限的一次性 `brief`、`away_summary`、`sleep`、`monitor` Harness 适配；RemoteTrigger 和 Agent trigger 不在无凭据/ACP registry 时伪装成可运行 |
| Background Sessions | job 有 owner/session、worker、token budget、heartbeat、orphan、log cursor；`attach?after=` 读取游标，`stop` 原子级联 DB 状态并只向 Worker 发送匹配当前 turn 的受控命令 |
| 重启恢复 | Gateway 启动时调用 `recoverOrphans` 和 durable `claimDueJobs`；job 的下一次执行由 `next_run_at` 恢复，已完成步骤不会重新 claim |
| Web | Automation 页面展示 Goals、Workflows、Cron、Background jobs，并提供完成、取消、attach/stop 的控制入口；Docker Playwright 阶段 7 用例覆盖桌面/移动 viewport、Background attach、无横向溢出和无页面错误（1 pass，0 fail） |

验证命令：

```text
docker compose build gateway
docker run --rm --entrypoint bun deepharness-gateway x tsc --noEmit
docker run --rm -v <repo>/apps:/app/apps -v <repo>/packages:/app/packages -v <repo>/tests:/app/tests -w /app --entrypoint bun deepharness-gateway test tests/unit/scheduler.test.ts
```

固定时钟和 workflow discovery 测试结果：5 pass，0 fail；阶段 7 contract：3 pass，0 fail。Gateway smoke 中 `0007_phase_7` 已成功应用，Goal evidence gate、Workflow definition、Cron timezone 和 Background job 查询均返回预期结构。阶段 7 integration 还验证两步 YAML workflow 不重复完成、Goal continuation blocked audit、Cron 首次时间、三类 intent 幂等、attach/stop 和 RemoteTrigger 的明确 `501`。

阶段 7 集成测试已经加入 `compose.test.yaml` 的 Docker test profile，并在 `Makefile integration-test` 中可单独运行；它不依赖宿主机 Bun/Node/Python。

浏览器验证命令：

```text
docker compose -f compose.yaml -f compose.test.yaml run --rm test \
  node node_modules/@playwright/test/cli.js test \
  --config playwright.config.ts tests/e2e/phase-7.spec.ts
```

该用例在阶段 7 Gateway 镜像重建后通过；此前发现的非安全 origin 不支持 `crypto.randomUUID()` 已统一由 Web request ID fallback 处理。

## ACP/平台阻塞（保留证据）

1. vendor 的 `GoalTool`、`WorkflowTool`、Cron/Monitor local command 不是当前 ACP `available_commands_update` 的 prompt command；Harness 没有修改 vendor，而是通过外层持久控制面提交普通 ACP prompt。manifest 中这些能力保持 `advertised_by_acp=false`，并将 `invocable=false` 与适配证据分开记录。
2. Agent triggers 的注册入口是 vendor `src/commands/schedule/index.ts` 的 `local-jsx` 命令，触发调度器挂在 REPL hook；当前 ACP 没有 trigger registry 或 trigger-fired prompt 事件。阶段 7 只提供 Harness scheduler，未宣称 vendor trigger 原生可达。
3. Kairos/Brief/Away Summary 依赖 daemon 或终端生命周期。Gateway scheduler 只负责持久时钟、错过执行和恢复，不双重托管 vendor daemon；终端专用命令继续保留 `C/D` 分类。
4. `RemoteTrigger` 需要外部回调、认证和平台凭据，本阶段只保留 `background_jobs.type=remote_trigger` 的数据边界，没有在无凭据环境中标为 supported。

5. capability audit 的动态 ACP probe 在本环境无法完成登录：`packages/vendor-capabilities/src/acpProbe.ts:179` 抛出 `ACP prompt did not stream expected text: Not logged in · Please run /login`。因此本阶段没有把 probe 失败误写成新的 vendor manifest；静态 manifest、Harness contract 和阻塞证据仍然保留。

上述限制的源码和运行时策略记录在 capability manifest 的 known gaps；没有为绕过 ACP 缺口而修改 `vendor/claude-code`。
