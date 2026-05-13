---
id: redis-strong-dependency-fail-fast
title: Redis 强依赖与快速失败策略
description: 关于将 Redis 视为强依赖并采用快速失败策略，而非复杂的本地内存加 MongoDB 降级的架构决策记录。
keywords: [ocean chat, adr, 架构决策, redis, 快速失败, 降级, 基础设施]
tags: [ocean-chat, adr, decision-record]
---

# Redis 强依赖与快速失败策略

## 状态 (Status)

已接受 (Accepted)

## 日期 (Date)

2026-05-011

## Context (上下文)

在 Ocean Chat 的架构中，Redis 是强依赖的基础设施。它处理包括缓存、路由下发以及在线状态追踪在内的关键操作。

之前曾考虑过如果在 Redis 不可用时，实施一套复杂的本地内存 + MongoDB 降级机制。该降级策略旨在保持部分应用服务的运行，例如发号器继续通过 MongoDB 发出 `SyncSeqId`。

## Decision (决策)

将 Redis 视为**强依赖**，并计划抛弃复杂的降级方案。

采用业界对强依赖基础设施的标准做法：**Fail-Fast（快速失败）+ 弹性重试**：

1. **网络波动 / 单节点故障：** 在 Redis 客户端库 (`ioredis`) 层面配置自动重试和集群节点漂移支持。
2. **重试耗尽 / 全面宕机：** 连续重试 3 次仍然失败，直接抛出 `InfrastructureException`（HTTP 503 或 RPC 异常）。网关捕获后，提示用户“网络开小差，请重试”，以此保护底层的 MongoDB 免受雪崩冲击。

## Alternatives Considered (替代方案评估)

### 本地内存 + MongoDB 降级

- **优点：** 也许能让某些孤立的操作（如发号器）在 Redis 宕机时短暂存活。
- **缺点：** 引入了巨大的代码复杂性，掩盖了底层基础设施的故障，且无法阻止核心聊天功能的最终失败，因为完整的消息链路本质上需要 Redis。
- **拒绝理由：** 架构成本远大于有限的收益，在部分中断期间会导致系统状态不可预测。

## Consequences (结果与影响)

- **木桶效应与全链路瘫痪：** 许多业务强依赖 Redis 的正常运转。哪怕费尽心机让发号器通过 MongoDB 降级成功发出了 `SyncSeqId`，也无济于事。`oceanchat-presence`（在线状态）依赖 Redis，路由下发依赖 Redis 缓存，离线推送折叠也依赖缓存。Redis 挂了，消息根本投递不出去。Redis 是为了保证高性能而引入的重要基础设施，如果 Redis 集群宕机，可以默认整个应用就瘫痪了。

- **杜绝掩盖 P0 级严重故障：** Redis 集群（Sentinel 或 Cluster 模式）全面宕机是一个绝对的 P0 级灾难。基础设施的问题应该交给基础设施层（自动主从切换、扩容）来解决。如果代码里做了静默降级，反而会掩盖故障，导致运维监控不能第一时间拉响最高级别警报。

- **保护持久化存储：** 通过快速失败并返回 503 错误，能有效防止雪崩般的请求冲击 MongoDB。MongoDB 本身并未被设计用来承受通常由 Redis 吸收的高吞吐量。
