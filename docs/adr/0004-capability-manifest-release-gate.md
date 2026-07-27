# ADR 0004: Capability Manifest 是发布门禁输入

- 状态：Accepted
- 日期：2026-07-27

## 背景

Vendor 工具、features、commands、Agents、providers 和集成会随上游变化；源码目录、编译结果和 ACP 可达性并不等价。

## 决策

每个锁定 vendor commit 同时运行静态源码审计和正式 ACP initialize/new session probe，并生成一份统一 manifest。每项能力记录稳定 id、A-E 分类、六维状态、条件、证据和最近测试结果。

人工复核文件与 vendor commit 绑定。新发现 id 不会继承宽泛默认结论，而是进入 `unclassified` 并阻止发布。`A/B` 退化、ACP 声明与实测不一致、enabled 但谎报 tested 同样阻止发布。

## 后果

升级必须提交 manifest、diff、contract report 和人工复核结果。需要真实凭据的能力可为 `not_tested`，但不能标记为 supported。
