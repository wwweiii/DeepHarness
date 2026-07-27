# ADR 0005: 业务容器不挂载 Docker Socket

- 状态：Accepted
- 日期：2026-07-27

## 背景

Docker Socket 等价于主机级控制权。将其挂载到 Gateway 或 Worker 会使 Agent 工具和供应链代码能够逃逸业务边界。

## 决策

Gateway、Worker 和 Agent 进程均不得访问 `/var/run/docker.sock` 或等价 daemon endpoint。首版由 Compose 静态创建服务；Worker 只管理自身容器内的普通子进程。

## 后果

需要容器级调度时必须引入独立、最小权限的外部控制面，并另行评审。不得以“临时开发便利”为由给业务容器增加 socket mount。
