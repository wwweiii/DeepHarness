# ADR 0003: PostgreSQL 保存控制面事件，Transcript 保存模型上下文

- 状态：Accepted
- 日期：2026-07-27

## 背景

浏览器事件不足以重建 Claude Code 的完整模型消息历史，但控制面仍需可靠保存会话状态、命令、审批、usage 和审计轨迹。

## 决策

PostgreSQL 是 Harness 控制面事实来源；vendor JSONL transcript 是 Agent 恢复上下文的事实来源。事件先持久化后广播，并使用客户端幂等键、事件 UUID 和会话内单调序号去重。`harness_session_id` 与 `agent_session_id` 分开存储。

## 后果

恢复流程必须核对两类事实来源。缺失或损坏的 transcript 进入明确 recovery 状态，Gateway 不从 UI delta 猜测或重建内部模型历史。
