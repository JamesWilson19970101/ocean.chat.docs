---
id: design-decisions-faq
title: 架构决策与 FAQ
sidebar_label: 架构决策与 FAQ
description: 深入解析 Ocean Chat 的核心架构决策，涵盖 NATS JetStream、事件驱动授权、内存安全以及高并发消息模式。
keywords:
  [
    ocean chat,
    架构,
    nats,
    jetstream,
    事件驱动,
    微服务,
    faq,
    架构决策,
    十万级并发,
    零 I/O 认证,
    内存安全,
  ]
---

import DecisionCard from '@site/src/components/DecisionCard';

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="架构决策与 FAQ | Ocean Chat" />
  <meta property="og:description" content="深入解析 Ocean Chat 的核心架构决策，涵盖 NATS JetStream、事件驱动授权以及十万级并发处理模式。" />
  <link rel="canonical" href="https://docs.oceanchat.com/zh-CN/docs/devdocs/design-decisions-faq" />
</head>

# 架构决策与 FAQ

本文档深入探讨了 Ocean Chat 背后的技术架构决策。为了支持 **十万级（100k+）并发连接**，系统的每一项设计都经过了严格优化，以确保确定性的性能、极高的资源效率和绝对的安全。

## NATS 与事件驱动架构

<DecisionCard
title="为什么将 AUTH_STATE 和 AUTH_EVENTS 隔离为独立的流？"
category="NATS"
severity="critical"
summary="严格隔离控制平面（撤销）与数据平面（登录），保护安全信号免受业务流量激增的影响。"

>

在 NATS JetStream 中，流（Stream）是一种轻量级的逻辑结构。真正的开销在于消费时的网络带宽和 CPU 占用。我们强制执行严格隔离基于以下三个原因：

1.  **保留生命周期**：`AUTH_STATE`（撤销信号）是瞬态的，存在于极速的 **内存存储** 中（约 15-30 分钟窗口）。`AUTH_EVENTS`（业务登录事件）需要长期审计，持久化在 **磁盘存储**（SSD）中保留数天。
2.  **噪音隔离**：网关通过 **扇出广播（Fan-out Broadcast）** 模式消费 `AUTH_STATE`。如果合并，每个节点每秒都将被迫处理并丢弃数千个无关的业务事件，从而导致 CPU 飙升。
3.  **关键路径保护**：像 `auth.jwt.revoke` 这样的安全指令是红线级别的关键数据。物理隔离保证了业务流量的洪峰永远不会延迟全局安全策略的执行。

</DecisionCard>

<DecisionCard
title="为什么通过 NATS 发布 loggedIn 事件而不是直接进行 RPC 调用？"
category="NATS"
severity="important"
summary="消除登录关键路径上的同步阻塞，并为下游消费者实现无限的可扩展性。"

>

1.  **极致解耦**：认证服务无需关注谁在消费这些数据（在线状态、分析服务等）。
2.  **零同步阻塞**：为了支持十万级并发，登录接口必须在 50ms 内响应。NATS 从关键路径上消除了所有下游网络 I/O。
3.  **流量削峰**：在流量激增期间（如全局推送），NATS 会将事件缓冲在磁盘上，允许下游服务以其最大安全速率拉取数据，避免系统崩溃。

</DecisionCard>

<DecisionCard
title="为什么选择现代 NATS Consumer API 而非 js.subscribe()？"
category="NATS"
summary="利用临时有序消费者（Ephemeral Ordered Consumers）提升可靠性，并通过异步迭代完美适配 Node.js 事件循环。"

>

1.  **临时有序消费者**：在网络重连期间自动处理序列追踪和重置，无需繁杂的服务端管理。
2.  **异步迭代（consume()）**：通过 `for await` 完美适配 Node.js 事件循环，确保消费逻辑非阻塞。

</DecisionCard>

## 性能与内存安全

<DecisionCard
title="为什么使用自定义的 BoundedPublisherService 而不是 p-limit？"
category="Performance"
severity="critical"
summary="通过强制执行任务积压的硬限制并优先处理关键安全流量，防止 V8 堆内存 OOM（溢出）。"

>

标准的并发库如 `p-limit` 使用 **无界内部数组** 来存储任务积压。在极端负载下，这个数组会持续膨胀直至触发 **OOM（内存溢出）** 崩溃。我们的自定义解决方案提供了：

- **有界背压（Backpressure）**：强制执行 `maxQueueSize`。一旦达到限制，系统会主动丢弃非核心任务以维持稳定性。
- **配额隔离**：确保关键的安全信号比普通业务事件拥有更高的优先级，防止流量高峰时的“队头阻塞”。

</DecisionCard>

<DecisionCard
title="为什么在 Repository 层强制执行严格的 “POJO-only” 策略？"
category="Performance"
severity="important"
summary="通过完全绕过 Mongoose Document 实例化，减轻垃圾回收（GC）压力和 CPU 开销。"

>

Mongoose `Document` 实例是包含复杂内部状态的重型类。在十万级并发规模下，它们会造成巨大的垃圾回收（GC）压力。

- **读操作**：使用 `.lean()` 在驱动层完全绕过 Document 实例化。
- **写操作**：在返回 Service 层之前立即调用 `.toObject()`。

</DecisionCard>

<DecisionCard
title="为什么对内部 NATS 消息执行 “零信任” 校验？"
category="Safety"
summary="将内部基础设施视为不可信源，防止畸形数据破坏主数据库。"

>

即便在内部基础设施中，我们也视其为不可信的数据源，以确保数据完整性。

1.  **严格类型**：每条消息都会经过 `class-transformer` 和 `class-validator` 处理，防止非法数据（如 `Invalid Date`）污染 MongoDB。
2.  **ACK/NAK 路由**：校验失败的消息会立即执行 `ack()`，防止无限重推死循环；而业务/数据库失败则执行 `nak()` 以触发重试。

</DecisionCard>

## 缓存策略

<DecisionCard
title="授权缓存的最终一致性"
category="Caching"
severity="important"
summary="采用 L1/L2 双层缓存策略，配合 10 秒 TTL，保护 MongoDB/Redis 免受请求洪峰冲击。"

>

在大规模并发下，对每一次权限检查都查询 MongoDB 或 Redis 是不可能的。我们在 `RoleCacheService` 中采用了双层策略：

1.  **L1 本地内存缓存**：每个 Node.js 实例中的 LRU 缓存（10,000 条目，10s TTL）。
2.  **L2 分布式缓存 (Redis)**：带抖动保护的共享分布式缓存。

:::warning 安全影响：最终一致性
权限变更（如注销成员）最多需要 **10 秒** 才能在全局生效。我们接受这种权衡，以换取亚毫秒级的本地响应速度，并为绝大多数请求实现零网络开销。
:::

</DecisionCard>

## 消息架构

<DecisionCard
title="控制平面 vs 数据平面"
category="Messaging"
severity="important"
summary="使用纯 WebSocket 进行高频信令传输，并采用 HTTP/WS 混合模式处理富媒体，防止管道阻塞。"

>

### 控制平面：纯粹的长连接收发

`MSG_UP` 指令允许通过 WebSocket/TCP 通道直接发送文本消息。

- **开销压缩**：采用 12 字节固定二进制 Header + Protobuf，彻底消除了 HTTP Header 带来的巨大开销。
- **智能保活**：每一条上行消息都会自动刷新连接 TTL，客户端可以省去专门的 PING 心跳，对移动端极度省电。

### 数据面：长短链接协同

对于大体积媒体文件（图片、语音），我们避免阻塞 WebSocket 管道：

1.  **上行 (HTTP)**：客户端通过标准 HTTP `POST`/`PUT` 将切片上传至 OSS。
2.  **下行 (WebSocket)**：客户端仅通过 `MSG_UP` 发送极轻量的 Protobuf 通知（包含 URL 和元数据），由网关负责推送。

</DecisionCard>

<DecisionCard
title="无状态与幂等性"
category="Messaging"
summary="架构设计支持绝对的水平扩展和全链路幂等，以应对网络抖动和流量激增。"

>

- **无状态网关**：`oceanchat-ws-gateway` 是纯粹的字节流封包器，业务逻辑完全隔离在路由层。
- **全链路幂等**：每条消息都有唯一的 `ClientMsgId`。后端配合 Redis Set 进行强制去重，即便网络抖动导致客户端重发，也不会产生重复消息。
- **推拉结合**：针对万人大群，我们只发送轻量级的 `MSG_NOTIFY` 唤醒通知。客户端通过 `SYNC_REQ` 接口主动拉取内容，避免瞬间击穿全球出口带宽。

</DecisionCard>
