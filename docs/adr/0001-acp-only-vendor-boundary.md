# ADR 0001: ACP 是唯一 Vendor 执行边界

- 状态：Accepted
- 日期：2026-07-27

## 背景

`vendor/claude-code` 的 `QueryEngine`、工具注册、AppState 和 bootstrap state 高度耦合 Bun feature 与进程级全局状态。直接 import 会把 DeepHarness 绑定到非稳定内部 API，并扩大 vendor 升级风险。

## 决策

业务运行时只允许以参数数组启动锁定构建的 `ccb-bun --acp`，通过 stdin/stdout 传输 ACP NDJSON。stdout 只承载协议；stderr 独立采集。DeepHarness 不 import `QueryEngine`、`query()`、`getTools()`、`AppState` 或 `bootstrap/state`。

只读审计器可以读取 vendor 源码作为构建期证据，但不得执行或修改内部模块。动态审计必须启动正式 ACP 子进程。

## 后果

ACP 未暴露的能力保持 `C`，不得通过 vendor 业务补丁伪装支持。通用修复优先提交上游，升级后重新运行 contract tests 与 capability diff。
