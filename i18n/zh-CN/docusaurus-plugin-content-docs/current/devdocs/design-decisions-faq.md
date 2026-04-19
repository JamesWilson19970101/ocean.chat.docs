---
id: design-decisions-faq
title: 架构决策与常见问题 (FAQ)
sidebar_label: 架构决策与 FAQ
description: Ocean Chat 核心架构决策解析，涵盖 NATS JetStream 流隔离与事件驱动认证。
keywords: [ocean chat, 架构, nats, jetstream, 事件驱动, 微服务, faq, 架构决策]
---

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="架构决策与常见问题 (FAQ) | Ocean Chat" />
  <meta property="og:description" content="Ocean Chat 核心架构决策解析，涵盖 NATS JetStream 流隔离与事件驱动认证。" />
  <link rel="canonical" href="https://jameswilson19970101.github.io/ocean.chat.docs/zh-CN/docs/devdocs/design-decisions-faq" />
</head>

# 理解 JetStream 架构决策

本文档解释了 Ocean Chat 中 NATS JetStream 集成的核心架构决策，重点说明了为什么系统如此设计以安全高效地支持千万级并发连接。

## 为什么隔离 `AUTH_STATE` 和 `AUTH_EVENTS` 而不是使用单个 Stream？

乍看之下，为单个微服务（如 Auth Service）创建多个 Stream 似乎增加了不必要的开销。然而，在 NATS JetStream 中，Stream 只是一个轻量级的逻辑结构。创建 Stream 的物理成本几乎为零。真正的成本在于**消费期间的网络带宽和 CPU 消耗**。

我们将 `AUTH_STATE`（用于 JWT 撤销）和 `AUTH_EVENTS`（用于登录等业务事件）严格隔离到独立的 Stream 中，主要基于以下三个关键原因：

### 1. 截然不同的保留生命周期 (Retention Lifecycle)

- **`AUTH_STATE` (控制信号):** 令牌撤销是一个极度时间敏感的瞬态信号。我们只需要在极快的**内存存储 (Memory Storage)** 中保留这些信号很短的窗口（例如 15-30 分钟）。
- **`AUTH_EVENTS` (历史数据):** 业务事件（如 `user.loggedIn`）对于长期的审计、统计和异步任务至关重要。这些数据必须在**文件存储 (File Storage, SSD)** 中保留数天以保证持久化。

合并它们将迫使我们做出妥协：要么在历史数据上浪费昂贵的内存，要么因磁盘 I/O 拖慢关键的安全信号。

### 2. 防止扇出雪崩 (Noise Isolation)

Ocean Chat 网关使用**扇出广播 (Fan-out Broadcast)** 策略（每个节点接收每条消息）消费 `AUTH_STATE` 流，以实现零 I/O (Zero-I/O) 认证。

如果我们将业务事件（每秒 10,000+ 次登录）合并到与令牌撤销（每秒 10 次）相同的流中，每一个网关节点将被迫每秒下载、反序列化并丢弃数以千计的无关登录事件。这将导致巨大的 CPU 峰值和网络拥塞。隔离 Stream 确保网关只处理它们真正需要的精确信号。

### 3. 关键路径保护 (Critical Path Protection)

像 `auth.jwt.revoke` 这样的安全指令是**红线级别**的关键数据。如果下游统计服务发生故障导致 `AUTH_EVENTS` 达到其容量限制，我们绝不能允许令牌撤销被丢弃或延迟。物理隔离保证了业务数据的激增永远不会影响全局安全策略的执行。

---

## 为什么 `loggedIn` 事件通过 NATS 发布而不是直接的 RPC 调用？

当用户成功登录时，Auth Service 会向 NATS 发布一个 `auth.event.user.loggedIn` 事件，而不是直接调用下游服务（如在线状态、审计或分析）。这是一个基础的**事件驱动架构 (Event-Driven Architecture)** 决策。

### 1. 极致解耦 (Extreme Decoupling)

Auth Service 的唯一职责是验证身份并颁发令牌。通过广播事件，Auth Service 不需要知道还有哪些其他服务关心登录动作。

### 2. 消除同步阻塞 (Elimination of Synchronous Blocking)

为了支持千万级并发，登录 API 必须在 50 毫秒内响应。如果 Auth Service 使用 RPC 调用来通知推送服务，网络延迟或下游故障将直接阻塞用户的登录。向 NATS 发布“即发即弃 (Fire-and-Forget)”事件，从关键路径上消除了所有同步网络 I/O。

### 3. 无限扩展性 (Infinite Scalability)

当出现新的业务需求时（例如“每日登录奖励”系统），我们无需修改 Auth Service。新的微服务只需在 `AUTH_EVENTS` 流上创建一个拉取消费者 (Pull Consumer) 即可。

### 4. 峰值负载平滑 (Traffic Shaping)

在流量激增期间（例如，推送通知导致 100,000 名用户同时打开应用），像数据库审计这样的下游服务可能会不堪重负。NATS JetStream 会安全地将这些事件缓冲在磁盘上。然后，下游服务可以以其最大安全消费速率拉取 (Pull) 事件而不会崩溃，从而在保证零数据丢失的同时维护系统的稳定性。
