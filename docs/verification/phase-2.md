# 阶段 2 验收记录：核心工具、权限与 Provider

- 验收时间：2026-07-28 15:16 CST
- Vendor：`claude-code-best/claude-code` `v2.8.4`
- 锁定 commit：`34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d`
- 结论：阶段 2 的实现、持久交互、Provider profiles、Capability 证据和发布门禁均通过；两个新增 ACP 限制保留为可复现 `expected_failure`，没有修改 vendor 或谎报原生支持。

## 实现范围

- Web 对所有 67 个已发现工具提供 schema-aware generic renderer，未知工具的输入、partial/final output 和错误不会丢失。
- File read/write/edit、Bash、Glob/Grep、Notebook、Plan/Todo 和 AskUserQuestion 具备专用展示与真实 ACP integration 场景。
- Gateway 持久化 permission/question、usage、配置与审计事件；批准、拒绝、超时默认拒绝和刷新后继续处理均有覆盖。
- Worker 映射 ACP tool lifecycle、Plan/Todo、usage、prompt queue、model 和 permission mode；缺失的 vendor 终态只生成带 `inferred=true` 与 `knownGap` 的诚实推断事件。
- Session Inspector 展示状态、模式、模型、Provider、队列、事件数和 token usage；ACP 未提供 cost 时显示 unavailable，不估算或伪造。
- Capability 页面直接读取统一 manifest，展示六维状态、矩阵分类、运行证据、Provider 状态和已知缺口。
- PostgreSQL migration `0002_phase_2.sql` 提供权限请求、usage 与审计持久化结构。

## 完整自动门禁

测试镜像重建后，从空 PostgreSQL `tmpfs` 栈执行原样命令：

```text
docker compose -f compose.yaml -f compose.test.yaml down
docker compose -f compose.yaml -f compose.test.yaml run --rm test
```

最终结果：

- `tsc --noEmit`：通过。
- Contract：22 pass / 0 fail / 4078 assertions。
- Unit：9 pass / 0 fail / 35 assertions。
- Phase 1 integration：1 pass / 0 fail / 10 assertions。
- Phase 2 integration：1 pass / 0 fail / 156 assertions，真实 `ccb-bun --acp` 链路耗时约 31.4s。
- Playwright E2E：Phase 1 与 Phase 2 共 2 pass，耗时 20.6s。

Phase 2 integration 覆盖 10 个本阶段核心工具场景、批准/拒绝/超时、问题刷新恢复与回答、Plan/Todo、usage、model/mode、顺序 prompt queue、Provider/Capability API、事件 replay 和数据库持久化。Unit 与 E2E 另覆盖未知工具 generic renderer 及移动布局。

截图制品：

- `output/playwright/phase-2-desktop.png`：1440x900。
- `output/playwright/phase-2-mobile.png`：390x844。

两张截图均人工复核，无控件重叠或页面级横向溢出。

## Capability 与发布门禁

`make audit` 使用锁定 vendor 的正式 `ccb-bun --acp` 和隔离 fake Anthropic endpoint，结果为：

- 389 项 capability，`unclassified=0`。
- A=51、B=79、C=156、D=68、E=35。
- 6 个 known-gap contract，全部为 `expected_failure`。
- Phase 1→2 diff：77 changed、0 added、0 removed、0 regressions。
- `unreviewed_additions=[]`、`unapproved_regressions=[]`。

日常 `make audit` 现在把新生成制品写入容器 `/tmp/deepharness-capability-audit`，以已发布 manifest 为 previous input 做漂移和回归门禁，不再覆盖发布 diff。实测 audit 前后：

```text
manifest b55b8defb55dac568018c5acd683bd38bc1ce9acf7d6534a5a51960eaeaa58f7
diff     97c9c084d854816842ed73fe825d8df4c38de6a0f87289d9d38fa8d04dc6825e
```

两份 SHA-256 均保持不变，diff 仍为 77 changes；对应保护已加入 contract test。

## Provider 状态

| Profile | 自动状态 | 真实 smoke | 结论 |
|---|---|---|---|
| Anthropic | `fake_passed` | 未在本阶段重复消耗真实凭据 | fake 协议链路 `passed` |
| Amazon Bedrock | `config_validated` | 无凭据，未执行 | `not_tested` |
| Google Vertex AI | `config_validated` | 无凭据，未执行 | `not_tested` |
| Microsoft Foundry | `config_validated` | 无凭据，未执行 | `not_tested` |
| OpenAI-compatible | `config_validated` | 无凭据，未执行 | `not_tested` |
| Google Gemini | `config_validated` | 无凭据，未执行 | `not_tested` |
| xAI Grok | `config_validated` | 无凭据，未执行 | `not_tested` |

每个真实 Provider 都有独立 Compose smoke profile。smoke 在启动 Agent 前检查 selector 冲突和凭据 alternative 完整性，只白名单传递该 Provider 需要的环境变量，并限制为一个带超时的低成本 prompt。没有凭据的 profile 在 manifest 与 UI 中只显示 configured/config validated，不显示 tested 或 supported。

## ACP 阻塞证据

### AskUserQuestion 回答输入

- Gap：`gap.acp.ask-user-question-updated-input`。
- ACP `session/request_permission` outcome 只能返回 option ID，不能返回 `updatedInput.answers`。
- Harness 会持久化结构化答案，并发送带审计记录的同 turn follow-up prompt；刷新后仍可完成回答。
- 状态保持 `expected_failure`，后续等待支持更新工具输入的上游 ACP 方案，再移除兼容适配。

### 工具原生终态与 raw output

- Gap：`gap.acp.tool-result-terminal-update`。
- Vendor `src/services/acp/bridge/forwarding.ts:311` 跳过携带 `tool_result` 的 SDK user message，因此模型收到工具结果，但 ACP client 收不到 terminal `tool_call_update` 和原始 `rawOutput`。
- Harness 在 prompt 完成时将仍在运行的工具标记为推断终态：`inferred=true`、`rawOutput=null`，并附带明确 `knownGap`；不冒充 vendor 原生结果。
- TodoWrite 使用 ACP `plan` 事件，不伪造普通 tool-call lifecycle。

其余四个既有 ACP gap 为 image input、dynamic MCP tools、local/local-jsx commands 和 agent version drift；均保留源码/运行时证据、expected-failure contract 和 upstream strategy。

## 构建与容器边界

- 浏览器镜像的无缓存构建期间曾观察到清华镜像 HTTP 连接中断和 Debian CDN 5xx；最终通过独立 `browser-runtime` 缓存层、BuildKit APT cache、`Acquire::Retries=3` 和三轮 install retry 消除偶发失败，后续 `docker compose build` 通过。
- Gateway、Worker、PostgreSQL 的标准 Compose 服务最终均为 `healthy`；测试 one-off 与 `test-model` 孤儿容器已移除。
- 实际 mounts 不包含 `/var/run/docker.sock`；Worker 空闲时没有残留 `ccb-bun`/Agent 子进程。
- vendor submodule 工作树为空，HEAD 与锁定 commit 一致；业务代码仍只通过 ACP 使用 vendor。
- `git diff --check` 通过。
