# ADR 0002: 每个活跃会话使用独立 Agent 进程

- 状态：Accepted
- 日期：2026-07-27

## 背景

Vendor 内核维护进程级 session id、CWD、模型、cost、settings cache，并在部分路径调用 `process.chdir()`。在一个 Agent 进程内并发承载多个 Harness 会话存在状态串扰风险。

## 决策

一个活跃 Harness 会话对应一个 `ccb-bun --acp` 子进程。每个子进程拥有独立 ACP client、stderr ring buffer、取消控制器和生命周期状态。Worker 容器可以托管多个进程，但必须实施最大并发和同一物理工作区写锁。

## 后果

进程退出只终止其所属会话。空闲回收后恢复必须创建新进程并走 ACP resume/load，不能复用其他会话进程。
