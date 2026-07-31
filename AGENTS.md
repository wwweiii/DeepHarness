# DeepHarness

## 项目介绍

DeepHarness 是一个围绕 `vendor/claude-code` 构建的私有 Web Agent Harness。

主要组件：

- `apps/web`：React、Vite 和 assistant-ui 前端。
- `apps/gateway`：Hono API、SSE 事件流、Worker WebSocket 和会话控制。
- `apps/worker`：启动并管理 `ccb-bun --acp` 子进程。
- `packages/protocol`：Gateway、Worker 和 Web 的共享协议。
- `packages/database`：PostgreSQL 数据访问和 migration。
- `packages/vendor-capabilities`：vendor 能力发现、ACP probe、分类和 diff。
- `vendor/claude-code`：Agent 内核，以 Git submodule 管理。

主要数据流：

```text
Web -> Gateway -> Worker -> ccb-bun --acp
Web <- SSE events <- Gateway <- Worker <- ACP updates
```

DeepHarness 只通过 ACP 使用 vendor。PostgreSQL 保存控制面事件，vendor transcript 保存 Agent 模型上下文。

## 使用 CodeGraph 快速理解架构

本项目有两个独立的 CodeGraph 索引：

- DeepHarness 自研代码：仓库根目录。
- Vendor 源码：`vendor/claude-code`。

查询自研代码时使用仓库根目录作为 `projectPath`；查询 vendor 时必须将 `projectPath` 明确指向 `vendor/claude-code`。

具体调用方法遵循 CodeGraph MCP 工具自带说明。

分析跨服务流程时，分别查询根索引和 vendor 索引，再根据协议与事件名称串联结果。

## Docker Compose 生命周期

- Codex 启动的 Docker Compose 服务在任务结束、失败或中断后必须关闭：`docker compose ... down --remove-orphans`。
- 默认不要使用 `down -v`，不要删除 named volume 或用户数据；不要关闭任务开始前已有的服务。
