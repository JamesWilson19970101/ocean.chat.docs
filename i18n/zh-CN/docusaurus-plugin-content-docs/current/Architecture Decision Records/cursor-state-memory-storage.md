---
id: cursor-state-memory-storage
title: ADR - CURSOR_STATE 流采用内存存储
sidebar_label: 游标状态内存存储
description: 架构决策记录：为何在 JetStream 的 CURSOR_STATE 流中激进采用 Memory 存储以换取无敌吞吐量，并依赖客户端去重机制实现容灾。
keywords: [ocean chat, adr, nats, jetstream, 内存存储, 游标状态, 去重]
tags: ["ocean-chat", "adr", "decision-record"]
---

# 架构决策记录：CURSOR_STATE 流采用内存存储

## 状态

**已接受 (Accepted)**

## 日期

2026-05-08

## 上下文 (Context)

在 Ocean Chat 的架构中，客户端在拉取消息后会极其频繁地发送 `[0x0B] READ_RECEIPT` 确认信令。为了保护底层的 MongoDB 和 Redis 免遭 IOPS“写入风暴”的冲击，这些游标更新指令（`lastAckSeqId` 和 `lastReadSeqId`）被异步路由到了一个专属的 NATS JetStream 流中，命名为 `CURSOR_STATE`。

该流通过配置 `MaxMsgsPerSubject=1`，能够在队列层面对高频更新进行自动折叠，使得每个用户在每个群组中永远只保留最终的游标状态。随后，`MessagePersistence` 工作单元会批量拉取这些去重后的状态，并向 Redis 和 MongoDB 执行双写落盘（BulkWrite / Pipeline）。

摆在面前的关键架构决策是该 NATS 流的底层存储介质选择：是采用相对安全的 `File`（磁盘/SSD），还是采用激进的 `Memory`（内存）？

## 决策 (Decision)

`CURSOR_STATE` 流将明确采用 **`StorageType.Memory` (内存存储)**。

## 决策依据 (Rationale)

`CURSOR_STATE` 流的核心定位是一个极速的**异步写缓冲 (Write-behind Cache)**。通过舍弃磁盘写入转而拥抱纯内存存储，系统能够在 NATS 层面获得理论上的最高吞吐量和最低延迟。

内存存储的固有风险在于：一旦 NATS 服务器发生灾难性宕机（或断电），系统将会丢失尚未被 Worker 拉取落盘的这几秒钟的游标确认数据。然而，在当前的业务领域模型下，这种微小的数据丢失是**绝对无害**的，这得益于系统精妙的最终一致性设计：

1.  **客户端游标回退：** 如果服务端丢失了最新的一批 `lastAckSeqId`，当客户端下次发起同步请求时，服务端只能基于 Redis/MongoDB 中记录的较老位置进行查库。这会导致服务端将一部分客户端已经见过的历史消息重新下发。
2.  **客户端静默去重 (Idempotent Discard)：** 客户端内部严格依赖本地的 SQLite 数据库以及唯一的 `ClientMsgId` 进行天然去重。当它发现拉取下来的数组中包含已存在的 ID 时，会直接将重复消息静默丢弃，绝不会在 UI 上呈现重复内容。
3.  **状态自愈 (Self-Healing)：** 客户端在处理完这批数据后（或在断线重连时），会立刻基于本地最新的序列号再次向服务端发送一次 `READ_RECEIPT` 信令，瞬间将服务端的游标状态修复至最新。

因此，为了几秒钟内随时可以自愈的中间状态去追求严格的磁盘持久化，完全是一种性能上的累赘。本设计选择用容忍极低概率的中间状态丢失，来换取极致的 I/O 效率。

## 考虑过的替代方案 (Alternatives Considered)

### StorageType.File (SSD 磁盘存储)

- **优点：** 确保即使 NATS 服务器崩溃或断电，也不会丢失任何一条游标更新记录。
- **缺点：** 强行在一个专为吸收每秒数百万次瞬态状态变更而设计的流上施加了磁盘 I/O 瓶颈。即使配备了顶级的 NVMe SSD 并且利用了 `MaxMsgsPerSubject=1`，文件系统的开销依然会极大限制吞吐量上限。
- **拒绝原因：** 这种严苛的保障是多余的，因为客户端的状态机已经提供了极其健壮的降级与自愈机制。

## 产生的影响 (Consequences)

- **无敌的吞吐量 (Extreme Throughput)：** 网关能够以纯内存级别的速度将海量的确认回执倾泻到 NATS 中，确保在面临万人大群消息爆炸时，WebSocket 长连接毫无背压 (Backpressure)。
- **可控的降级重试：** 在极度罕见的 NATS 节点崩溃事件中，一小部分客户端可能会在下次同步时拉取到少量重复消息，但本地数据库会无缝、无感知地将其过滤。
- **降低基础设施成本：** 大幅减少了 NATS 集群所在机器的磁盘损耗 (TBW) 以及 IOPS 预置成本。
