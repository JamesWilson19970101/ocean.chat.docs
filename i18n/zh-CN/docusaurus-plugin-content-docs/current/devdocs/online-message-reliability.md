---
id: online-message-reliability
title: 如何保证在线消息的可靠性
description: 如何在 Ocean Chat 中实现应用层 ACK、幂等去重和序列号追踪，以确保消息零丢失。
keywords: [ocean chat, 消息可靠性, ack, 序列号, 幂等性, nats]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
---

本指南详细介绍了如何在 Ocean Chat 中实现绝对的在线消息可靠性。由于存在“假在线”状态、中间网络丢包以及应用层崩溃等问题，在即时通讯（IM）系统中仅依赖 TCP 层的可靠性是远远不够的。

为了保证消息被成功送达、处理并持久化，Ocean Chat 强制实施了一套基于幂等性、应用层确认（ACK）以及序列号追踪的严格协议。

本指南假设读者已了解 Monkey Protocol 的帧结构（特别是 `ReqId` 和 `SyncSeqId`）以及 NATS JetStream 架构。

## 第一步：实现客户端幂等性

网络的不稳定性迫使客户端必须重试发送消息。如果没有去重机制，重试会导致数据库中出现重复记录。

在发送上行消息时，客户端**必须**生成一个全局唯一的标识符（`ClientMsgId`）。

```json title="MSG_UP Payload Definition"
{
  "ClientMsgId": "123e4567-e89b-12d3-a456-426614174000",
  "Type": "TEXT",
  "Content": "Hello World"
}
```

oceanchat-message 服务利用 Redis 的 String 数据结构和 SET ... NX EX (不存在则设置并附带过期时间) 原子指令，将 UserID:ClientMsgId 作为唯一的键。这种方式不仅具备 O(1) 的极速性能，还能依靠 TTL（如 5 分钟）实现内存的自动清理，在重复重试到达数据库之前对其进行优雅的拦截和丢弃。

## 第二步：强制实施服务端写屏障

在消息挺过服务器崩溃之前，不能将其视为发送成功。但同步写入数据库会阻塞连接并降低吞吐量。

因此，应当使用 NATS JetStream 作为预写日志 (WAL) 来实现**写屏障 (Write Fence)**：

1. `oceanchat-message` 服务接收载荷，并分配一个 64 位的 `SyncSeqId`。
2. 该服务将载荷异步写入 NATS JetStream 的 `im.orchestrate.msg` 主题中。
3. **只有当** NATS JetStream 返回持久化确认时，才算越过了写屏障边界。

:::warning
在收到 JetStream 的 ACK 之前，严禁向客户端返回成功响应。
:::

## 第三步：要求应用层 ACK

TCP 的 ACK 仅确认字节已到达操作系统的网络栈。而应用层的 ACK 则确认业务逻辑已成功处理了这些数据。

一旦越过写屏障，网关**必须**返回一个 `[0x06] MSG_UP_ACK` 数据帧。该 ACK 帧头中的 24 位 `ReqId` 必须与原始 `[0x05] MSG_UP` 帧中的 `ReqId` 完全匹配。

**如何定义“成功处理”？**

- **发送方视角：** 只要客户端收到了 `MSG_UP_ACK`，这条消息就算作绝对发送成功了。
- **服务端视角：** 为了支撑十万级并发，服务端**不会**在发送 ACK 前将消息同步写入到底层数据库（如 MongoDB）。所谓“成功处理”，严格指的是消息已经跨过了**写屏障**（安全地保存在了 NATS JetStream 高可用 WAL 队列中）。在 NATS 确认持久化后，服务端立即下发 ACK，从而将快速的客户端响应与缓慢的数据库落盘解耦。

## 第四步：管理客户端超时与重试

发送方需要在内部维护一个“等待 ACK”的队列。

1. 在发出 `MSG_UP` 时启动一个定时器（例如 5 秒）。
2. 如果收到 `MSG_UP_ACK`，则将该消息从队列中移除。
3. 如果定时器超时仍未收到 ACK，则自动重新传输完全相同的载荷（包含原始的 `ClientMsgId`），并递增重试计数器。
4. 在超过最大重试次数（例如 3 次）后，在 UI 上将该消息标记为“发送失败”。

## 第五步：检测并自愈消息空洞

对于下行投递，为了防止大载荷阻塞长连接通道，服务器**仅通过 `[0x08] MSG_NOTIFY` 推送极轻量级的新消息唤醒通知**（不包含消息实体）。

**为什么不需要下行 ACK？**
Ocean Chat 在协议设计中故意去掉了单条消息的下行 ACK（`MSG_DOWN_ACK`）。在十万级并发或大群聊中，如果每发一条消息都要海量客户端回复 ACK，会导致可怕的“ACK 风暴”压垮服务端。作为替代，Ocean Chat 基于版本号（`SyncSeqId`）的**空洞检测（Hole Detection）**与**推拉结合（Push-Pull）**机制来保证下行消息绝对不丢。

由于 Ocean Chat 为了支持极高并发采用了基于号段的 ID 分配策略，因此载荷内部的 `SyncSeqId` 会是单调递增的，但**可能是不连续的**。

接收端客户端**必须**实现空洞检测 (Hole Detection)：

1. 在本地存储中维护一个 `MaxLocalSyncSeqId` 变量。
2. 在收到下行载荷时，将传来的 `SyncSeqId` 与本地的 `MaxLocalSyncSeqId` 进行比较。
3. 如果传来的 ID 更大，说明出现了缺口或跳跃。
4. **切勿猜测缺失的序号。** 应立即暂存该唤醒通知，并通过 **HTTP 短连接** 发起同步请求（附带当前的 `MaxLocalSyncSeqId`）。
5. `oceanchat-query` 服务将通过 HTTP 响应精确返回缺失消息的增量数据。
6. 渲染同步后的消息流，并更新 `MaxLocalSyncSeqId`。

## 预期结果

通过整合用于去重的 `ClientMsgId`、用于绝对持久化的 JetStream，以及用于空洞检测的 `SyncSeqId`，系统保证了分布式节点间的零消息丢失和精确排序，这完全独立于底层 TCP/WebSocket 连接的波动。
