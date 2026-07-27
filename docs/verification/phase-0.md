# 阶段 0 验收记录：Vendor 审计与架构基线

- 验收时间：2026-07-28 01:07 CST
- Vendor：`claude-code-best/claude-code` `v2.8.4`
- 锁定 commit：`34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d`
- Bun：`1.3.13`，仅在 Docker 内执行
- 结论：阶段 0 代码与运行验收通过；冷启动 registry pull 的本机 Docker daemon 异常作为外部环境证据保留，不影响已校验镜像上的 Compose 验收。

## Vendor 完整性

以下三项一致：外层 Git gitlink、submodule HEAD、`config/vendor-lock.json` 和最终 manifest 的 `vendor_commit`。

```text
34b3dc99bf40c57c0b78f3b5b1d70471ebc2d06d
```

`.gitmodules` 使用 HTTPS。`git -C vendor/claude-code status --porcelain=v1` 输出为空；构建所需的 ignored ripgrep 资产只由 vendor 自带 `scripts/postinstall.cjs` 在 builder 镜像层生成，没有写回 submodule。

## Capability 基线

`make audit` 通过，最终统一清单共 388 项：

| Kind | 数量 |
|---|---:|
| ACP | 27 |
| Agent | 7 |
| Command | 133 |
| Feature | 93 |
| Integration | 28 |
| Provider | 7 |
| Runtime flag | 26 |
| Tool | 67 |

A-E 结果为 A=50、B=79、C=156、D=68、E=35，`unclassified=0`。93 个 feature 中 35 个进入锁定默认 build，58 个只存在于源码；没有未编译 feature 被标为 A/B。

人工复核文件的 388 个 id 与 manifest 精确相等。11 个 Docker contract tests 会逐项验证六维状态、分类、review 覆盖、静态证据路径、架构边界和 ACP 动态结果。

## ACP 动态证据

动态 probe 启动正式 `/opt/claude-code/dist/cli-bun.js --acp`，成功完成：

- `initialize`：protocol version 1，stdout 为纯 NDJSON，stderr 为空。
- `session/new`：返回 session id、6 个 permission modes、5 个 models 和 2 个 config options。
- `available_commands_update`：发布 9 个 prompt commands。
- `acp.initialize` 与 `acp.newSession` 在 manifest 中为 `invocable=true`、`tested=true`、`passed`。

当前四个预期失败均可复现：

| Gap | 运行时/源码证据 | 处理 |
|---|---|---|
| `gap.acp.image-input` | initialize 明确返回 `promptCapabilities.image=false`；prompt conversion 无 image 分支 | 保持 C，等待通用上游 ACP 修复 |
| `gap.acp.dynamic-mcp-tools` | initialize 宣告 MCP http/sse，但 `createSessionMethod.ts:181` 仍为 `mcpClients: []` | 保持 C，不修改 vendor 绕过 |
| `gap.acp.local-commands` | 静态发现 124 个 local/local-jsx，ACP 只发布 9 个 prompt commands，交集为 0 | 保持 C，Web 不伪装为可调用 |
| `gap.acp.agent-version-drift` | ACP 自报 `2.1.888`，vendor package 为 `2.8.4` | Worker 使用 gitlink/manifest 版本判定并等待上游修正元数据 |

任一 gap 变成 unexpected pass 或 probe error 时审计会失败，要求补正向 contract test 并人工重新分类。

## Docker 验收

以下命令通过：

```text
docker compose --profile audit build capability-audit
make audit
make typecheck
make contract-test
docker compose up --build --detach --wait
```

结果：TypeScript strict typecheck 通过；contract tests 为 11 pass / 0 fail / 3596 assertions；PostgreSQL、Gateway、Worker 均为 healthy。

运行时抽查：

- Gateway：`bun` 用户、read-only rootfs、零 mounts，`127.0.0.1:8080/readyz` 返回 ok。
- Worker：`bun` 用户、read-only rootfs、零 mounts，内部 `/readyz` 返回 `agentBoundary=acp-stdio` 和单会话单进程策略。
- PostgreSQL 17.5：`pg_isready` 返回 accepting connections，仅暴露于 Compose 网络。
- Compose 与实际 mounts 均不包含 Docker Socket。

## 外部环境证据

本机 Docker daemon 的配置包含多个 registry mirrors。`docker pull oven/bun:1.3.13`、DaoCloud 短名和 Docker Desktop 内部 Hub proxy 均连续超过 60 秒无输出；会话被中止为 exit 130。宿主 `curl` 访问 Docker Hub registry 则正常返回 HTTP 401 challenge，定位为 daemon pull/mirror 通道异常。

为继续验收，通过 DaoCloud OCI API 获取同一 `linux/arm64` manifest，逐层校验声明 size 与 SHA-256 后执行 `docker load`。导入镜像为：

```text
oven/bun:1.3.13
sha256:77f846d97dd1e4c2197e91f870c5fb28c8eef18f92ed107e9aa592ee001947a0
Bun 1.3.13
```

传输证据保留于 `/private/tmp/deepharness-bun-pull.tofRqL`。项目 Dockerfile 仍使用官方 `oven/bun:1.3.13`，因此正常 Docker 环境无需该本机 workaround。

首次 npm 官方 registry 下载还产生 `Integrity check failed for tarball: auto-bind`；锁文件阻止了不完整依赖进入构建。Builder 现默认使用可覆盖的 HTTPS `registry.npmmirror.com`，`--frozen-lockfile` 与 integrity 校验通过，2491 个 vendor packages 在 8.7 秒内安装完成。

## 发布制品

- `artifacts/capabilities/vendor-static-audit-report.json`
- `artifacts/capabilities/vendor-acp-probe-report.json`
- `artifacts/capabilities/vendor-capability-manifest.json`
- `artifacts/capabilities/vendor-capability-diff.json`
- `config/vendor-capability-review.json`

首份 diff 状态为 `baseline_created`，无 regressions、无 unreviewed additions。后续 vendor commit 必须以本清单为 previous 输入生成升级 diff。
