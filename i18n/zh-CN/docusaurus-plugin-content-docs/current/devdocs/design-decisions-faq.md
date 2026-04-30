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

我将 `AUTH_STATE`（用于 JWT 撤销）和 `AUTH_EVENTS`（用于登录等业务事件）严格隔离到独立的 Stream 中，主要基于以下三个关键原因：

### 1. 截然不同的保留生命周期 (Retention Lifecycle)

- **`AUTH_STATE` (控制信号):** 令牌撤销是一个极度时间敏感的瞬态信号。我只需要在极快的**内存存储 (Memory Storage)** 中保留这些信号很短的窗口（例如 15-30 分钟）。
- **`AUTH_EVENTS` (历史数据):** 业务事件（如 `user.loggedIn`）对于长期的审计、统计和异步任务至关重要。这些数据必须在**文件存储 (File Storage, SSD)** 中保留数天以保证持久化。

合并它们将迫使我做出妥协：要么在历史数据上浪费昂贵的内存，要么因磁盘 I/O 拖慢关键的安全信号。

### 2. 防止扇出雪崩 (Noise Isolation)

Ocean Chat 网关使用**扇出广播 (Fan-out Broadcast)** 策略（每个节点接收每条消息）消费 `AUTH_STATE` 流，以实现零 I/O (Zero-I/O) 认证。

如果我将业务事件（每秒 10,000+ 次登录）合并到与令牌撤销（每秒 10 次）相同的流中，每一个网关节点将被迫每秒下载、反序列化并丢弃数以千计的无关登录事件。这将导致巨大的 CPU 峰值和网络拥塞。隔离 Stream 确保网关只处理它们真正需要的精确信号。

### 3. 关键路径保护 (Critical Path Protection)

像 `auth.jwt.revoke` 这样的安全指令是**红线级别**的关键数据。如果下游统计服务发生故障导致 `AUTH_EVENTS` 达到其容量限制，我绝不能允许令牌撤销被丢弃或延迟。物理隔离保证了业务数据的激增永远不会影响全局安全策略的执行。

---

## 为什么 `loggedIn` 事件通过 NATS 发布而不是直接的 RPC 调用？

当用户成功登录时，Auth Service 会向 NATS 发布一个 `auth.event.user.loggedIn` 事件，而不是直接调用下游服务（如在线状态、审计或分析）。这是一个基础的**事件驱动架构 (Event-Driven Architecture)** 决策。

### 1. 极致解耦 (Extreme Decoupling)

Auth Service 的唯一职责是验证身份并颁发令牌。通过广播事件，Auth Service 不需要知道还有哪些其他服务关心登录动作。

### 2. 消除同步阻塞 (Elimination of Synchronous Blocking)

为了支持千万级并发，登录 API 必须在 50 毫秒内响应。如果 Auth Service 使用 RPC 调用来通知推送服务，网络延迟或下游故障将直接阻塞用户的登录。向 NATS 发布“即发即弃 (Fire-and-Forget)”事件，从关键路径上消除了所有同步网络 I/O。

### 3. 无限扩展性 (Infinite Scalability)

当出现新的业务需求时（例如“每日登录奖励”系统），我无需修改 Auth Service。新的微服务只需在 `AUTH_EVENTS` 流上创建一个拉取消费者 (Pull Consumer) 即可。

### 4. 峰值负载平滑 (Traffic Shaping)

在流量激增期间（例如，推送通知导致 100,000 名用户同时打开应用），像数据库审计这样的下游服务可能会不堪重负。NATS JetStream 会安全地将这些事件缓冲在磁盘上。然后，下游服务可以以其最大安全消费速率拉取 (Pull) 事件而不会崩溃，从而在保证零数据丢失的同时维护系统的稳定性。

---

## 为什么使用自定义的 `BoundedPublisherService` 而不是 `p-limit` 等库？

在超大规模并发（10M+）环境下，使用 `void js.publish()` 的标准“即发即弃”模式非常危险，因为它会产生无法预测的 Promise 堆积。虽然像 `p-limit` 这样的并发控制库很流行，但它不足以保护千万级规模的微服务。

### 1. `p-limit` 背后“隐藏”的无界数组

`p-limit` 能有效管理**并发数**（例如限制同时只有 100 个请求访问 NATS），但它使用一个**无界的内部数组**来存储积压的任务。

如果 NATS 响应变慢或网络抖动，而 Auth 服务依然以每秒 10,000 次的速度接收请求，`p-limit` 会将这些每秒数以千计的新 Promise 全部推入其内部数组。这个数组会持续膨胀并榨干 **V8 堆内存 (Heap Memory)**，最终不可避免地导致 Node.js 进程因 **OOM (内存溢出)** 崩溃。

### 2. 自定义方案：有界 Backlog + 隔离配额

我的 `BoundedPublisherService` 是为了解决 `p-limit` 忽略的内存安全问题而手写的：

- **有界队列 (背压机制)**：不同于 `p-limit`，我强制执行 `maxQueueSize`（如 5,000）。一旦积压达标，系统会主动丢弃新任务。这保证了无论 NATS 性能如何，V8 堆内存占用始终处于**确定性**的可控范围内。
- **隔离配额 (Quota Isolation)**：我实现了优先级机制，确保关键的安全撤销指令（revocations）拥有比普通业务事件（logins）更高的配额。这防止了业务洪峰“堵死”系统撤销令牌的能力。
- **零依赖与 PnP 兼容性**：避免了第三方库在 Yarn PnP 模式下的 ESM/CJS 兼容性开销。

在千万级规模下，**确定性的内存占用**比保证每一条非核心事件都成功发布更重要。

---

## 为什么使用现代 NATS Consumer API 而不是 `js.subscribe()`？

旧版本的 NATS 客户端使用 `js.subscribe()` 同时处理推（Push）和拉（Pull）消费者。在现代 NATS (v2.14+) 中，该方法已被废弃，取而代之的是更清晰、更强大的现代 API。

### 1. 临时有序消费者 (Ephemeral Ordered Consumers)

为了实现零 I/O 认证，我使用 `js.consumers.get('AUTH_STATE', { filterSubjects: [...] })`。这会在客户端自动管理一个高性能的**有序消费者**。它是临时的，无需服务端管理，并能在网络重连期间自动处理复杂的“序列追踪（Sequence Tracking）”。

### 2. 异步迭代 (`consume()`)

新的 `.consume()` 方法返回一个异步迭代器。这允许我使用标准的 `for await (...)` 循环，使消费逻辑非阻塞、易于阅读，并与 Node.js 事件循环完美对齐。

---

## 为什么在 Repository 层强制执行严格的 “POJO-only” 政策？

我严禁从 Repository 层（BaseRepository）返回 Mongoose `Document` 实例。所有方法（如 `find`, `findOne`, `create`, `update`）必须返回纯 JavaScript 对象（POJO）。

### 1. 巨大的内存/CPU 节省

Mongoose Document 是一个重量级类的实例，包含内部状态、变更追踪和数十个方法。在千万级系统中为每个请求实例化 Document 会导致巨大的 GC（垃圾回收）压力和高 CPU 占用。而 POJO 的开销几乎为零。

### 2. 实现手段：`.lean()` 与 `.toObject()`

- 所有读操作均使用 `.lean()`，在驱动层完全绕过 Document 的实例化。
- 所有写操作（如 `create`）在返回 Service 层之前立即调用 `.toObject()`。

---

## 为什么对每条 NATS 消息都执行 “零信任” 校验？

尽管 NATS 运行在我的 VPC 内部，但为了数据完整性，我将其视为不可信源（零信任）。

### 1. `plainToInstance` + `validateOrReject`

每条传入的消息都会经过 `class-transformer` 和 `class-validator` 处理。这确保了即使开发者在生产者端引入了 Bug，消费者也永远不会处理非法日期（如 `Invalid Date`）或缺失的 ID，从而避免污染 MongoDB。

### 2. 精确的 ACK/NAK 路由

- **校验失败**：我立即执行 `m.ack()`。这告诉 NATS 该消息是“坏账”，应当丢弃，从而防止无限红推死循环。
- **业务/数据库失败**：我执行 `m.nak()` 以触发重新投递，确保在瞬时基础设施故障时数据的最终一致性。

---

## 权限验证中的并发挑战

当 WebSocket 或 REST API 请求到达 Ocean Chat 网关时，系统必须验证用户的权限。在大规模下，对每一条消息或每一个请求都去查询主数据库（MongoDB）甚至分布式缓存（Redis）是不可能的。如果采用严格的一致性模型（即每次权限变更都必须是阻塞的，并且在所有实例中立即可见），将会导致严重的锁竞争和灾难性的延迟。

### 双层缓存架构

Ocean Chat 通过在 `RoleCacheService` 中实现双层缓存来解决这个问题：

1.  **L1 内存缓存（本地）：** 存在于每个微服务实例的 Node.js 内存空间中的 LRU（最近最少使用）缓存。它最多容纳 10,000 个条目，并具有严格的 10 秒生存时间（TTL）。
2.  **L2 分布式缓存（Redis）：** 跨所有实例共享的集中式缓存，受分布式锁（通过带抖动的 `getOrSet`）保护，以防止缓存雪崩。

### 权衡：最终一致性

通过依赖具有 10 秒 TTL 的 L1 内存缓存，我明确选择了**最终一致性（BASE）**，而不是强一致性（ACID）。

:::warning 安全影响
如果管理员撤销了用户的权限或将成员踢出房间，该变更最多需要 **10 秒钟**才能在全局生效。在这个时间窗口内，如果该用户之前的角色仍然存在于特定网关实例的 L1 缓存中，他可能仍被授权执行操作。
:::

### 为什么我接受这种权衡

- **零网络开销：** L1 缓存命中在亚毫秒级内解决，没有网络 I/O，完全隔离了 Redis 和 MongoDB 免受流量尖峰的冲击。
- **OOM 保护：** LRU 机制防止 Node.js 进程耗尽内存。
- **运维简单性：** 我避免了通过 NATS 向数千个 Pod 广播缓存失效事件的巨大复杂性。短暂的 10 秒 TTL 确保系统自然地自我修正，而无需人工干预。

## 更高层次的视角

在分布式社交和消息应用中，权限变更的绝对实时一致性很少是硬性的业务需求。与通过将授权路径与数据库 I/O 解耦所获得的大规模稳定性和吞吐量提升相比，权限撤销中 10 秒延迟对用户体验的影响微乎其微。一旦缓存过期并且系统拒绝后续操作，客户端将优雅地处理授权失败。

---
