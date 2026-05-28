---
id: offline-message-reliability
title: 如何保证离线消息的可靠性
sidebar_position: 4
description: 如何在 Ocean Chat 中利用 NATS JetStream WAL、分页 HTTP Sync 同步和客户端去重来确保离线消息零丢失。
keywords: [ocean chat, 离线消息, 可靠性, ack, 去重, 同步, nats, monkey protocol]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

# 如何保证离线消息的可靠性

本指南详细介绍了如何在 Ocean Chat 中实现离线消息的绝对可靠投递。当用户离线时，系统必须安全地持久化消息并触发第三方离线通知。当用户重新连接时，系统必须保证消息的准确送达，同时避免产生重复消息或导致网络过载。

Ocean Chat 依赖于 NATS JetStream 预写日志 (WAL)、用于第三方 APNs/FCM 投递的 `oceanchat-pusher-offline` 服务，以及 Monkey Protocol 中定义的严格的推拉结合 (Push-Pull) 同步模型。

## 第一步：通过 JetStream WAL 持久化消息

当 `oceanchat-message` 服务处理上行消息 (`MSG_UP`) 时，它会分配一个全局单调递增的 `SyncSeqId`，并将消息写入 NATS JetStream 的 `im.orchestrate.msg` 主题。

Ocean Chat 通过**写后持久化 (Write-after-persistence)** 机制来实现离线可靠性。只要 NATS JetStream 返回了发布确认 (ACK)，消息即被视为安全存储。后台的 `MessagePersistence Worker` 会异步拉取这些消息并批量写入 MongoDB。这种架构将快速的客户端响应与缓慢的数据库落盘彻底解耦。

## 第二步：触发离线推送通知

与此同时，`oceanchat-orchestrator` 推送编排服务会通过查询 `oceanchat-presence` 服务（基于 Redis）来评估目标用户的在线状态。

如果检测到目标用户没有任何活跃的 TCP/WebSocket 连接，编排器会将推送任务路由到专门的 `OFFLINE_PUSH` JetStream 流中。

为了防止大群消息引发“写扩散”雪崩并避免对用户造成惊扰，系统在此阶段采用**折叠与替换策略**：

1. **队列层去重**：任务会被发布到精确到用户的子主题（例如 `push.offline.apns.{user_id}`）。该流配置了 `MaxMsgsPerSubject = 1`，这意味着当万人大群瞬间产生大量消息时，NATS 会自动丢弃旧任务，队列中每个离线用户永远只保留最新的一次唤醒任务。
2. **厂商层折叠**：`oceanchat-pusher-offline` 离线推送工作单元通过 Pull Queue Group 从 `push.offline.*` 主题消费任务。在调用第三方厂商 API（如 Apple APNs 或 Google FCM）时，服务会附带折叠标识（如 `apns-collapse-id` 或 `collapse_key`）。操作系统的通知栏只会静默更新最新内容和未读数，避免频繁震动。
3. **物理隔离**：由于厂商 API 极易触发频率限制并产生高延迟，采用独立的 NATS 队列可以隔离故障，确保核心的 IM 实时流量 (`IM_CORE`) 不受影响。这种推送本质上只是一个“唤醒”信令，客户端启动后仍会依赖 `SYNC_REQ` 拉取完整历史内容。

## 第三步：实现分页批量拉取 (HTTP Sync)

当离线客户端被唤醒（例如，用户点击了 APNs 通知）时，它**绝不能**指望服务器通过长连接主动推送数百条遗漏的消息。

相反，客户端必须执行**主动拉取 (Pull)** 策略来修补消息空洞：

1. 客户端检查本地存储（如 SQLite/IndexDB）中保存的 `MaxLocalSyncSeqId`。
2. 客户端通过 **HTTP 短连接** 向 API 网关发送包含此 ID 的同步请求（例如 `GET /api/v1/messages/sync?seqId={MaxLocalSyncSeqId}`）。
3. `oceanchat-query` 数据查询服务接收 HTTP 请求，并从数据库 (MongoDB) 中查出所有严格大于该 `MaxLocalSyncSeqId` 的消息。
4. 服务器通过 HTTP 响应将缺失的消息数组返回给客户端。

:::warning 分页拉取
对于堆积了海量离线消息的用户，客户端必须使用分页机制（例如一次拉取 100 条消息），以防止大载荷引发接口超时或客户端内存溢出。
:::

## 第四步：强制执行客户端去重

在客户端与服务器执行 HTTP Sync 同步期间，网络波动或客户端重试可能会导致拉取到相同的缺失消息（这构成了“至少一次”的交付语义）。

接收端客户端**必须**实现去重机制：

1. 在解析 HTTP 响应载荷时，提取每条消息中的 `ClientMsgId`。
2. 查询本地设备数据库。如果发现具有相同 `ClientMsgId` 的消息已经存在，则静默丢弃该重复项。
3. 只有在整个批次的消息都成功持久化到本地之后，才更新本地的 `MaxLocalSyncSeqId` 游标。

## 预期结果

通过整合用于绝对服务端持久化的 NATS JetStream WAL、将第三方 APNs/FCM 调用物理隔离到 `OFFLINE_PUSH` 流，以及在重连时依赖带有本地去重逻辑的 HTTP Sync 机制，您可以保证离线用户准确无误地收到每一条遗漏的消息，同时丝毫不影响长连接网关的实时吞吐性能。
