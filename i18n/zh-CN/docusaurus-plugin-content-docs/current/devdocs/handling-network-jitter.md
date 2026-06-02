---
id: handling-network-jitter
title: 如何处理推拉结合模型中的网络抖动
sidebar_position: auto
description: 学习在 Ocean Chat 中协调长连接 (WebSocket) 与短连接 (HTTP) 时，如何处理网络抖动并保证消息的绝对可靠性。
keywords: [ocean chat, 网络抖动, 推拉结合, 可靠性, websocket, http 同步]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# 如何处理推拉结合模型中的网络抖动

在 Ocean Chat 的架构中，**推拉结合 (Push-Pull Hybrid)** 模型将控制面 (WebSocket) 与数据面 (HTTP) 严格分离。虽然这使得系统的扩展性达到了极致，但协调长短连接也引入了对网络抖动（Jitter）的脆弱性。

本指南说明了如何设计客户端 SDK 来应对不稳定的网络环境（如进出电梯、地铁弱网），确保当 WebSocket 通知与 HTTP 拉取发生脱节时，消息绝对零丢失。

:::tip 问题导向
这是一篇 **How-to Guide (操作指南)**。它假定你正在实现客户端的同步状态机逻辑，并需要处理由弱网引发的各种边缘异常情况。
:::

## 场景一：WebSocket `MSG_NOTIFY` 唤醒信令丢失

如果网络发生瞬间的闪断，服务端可能下发了 `[0x08] MSG_NOTIFY` 信令，但客户端根本没有收到。

### 解决方案：重连隐式同步 (空洞修补)

你**绝对不能**仅仅依赖实时通知来触发消息拉取。`SyncSeqId` 才是你唯一可信的真理源 (Source of Truth)。

1. **断线感知：** 客户端的非对称心跳机制（35秒兜底定时器）感知到死链，触发底层的断开与重连逻辑。
2. **建连即同步：** 一旦 WebSocket 重新建立并成功完成 `AUTH_REQ` 鉴权，客户端**必须立即**发起一次 HTTP Sync 同步请求，无论此时是否收到了新的 `MSG_NOTIFY`。
3. **拉取缺失数据：** 携带本地的 `MaxLocalSyncSeqId` 请求 `oceanchat-query` 服务：`GET /api/v1/messages/sync?seqId={MaxLocalSyncSeqId}`。
4. **结果：** 在断网期间错过的任何唤醒信令所对应的消息实体，都会在这次兜底同步中被安全拉回。

## 场景二：HTTP Sync 拉取请求失败

客户端通过 WebSocket 成功收到了 `MSG_NOTIFY`，但随后的 HTTP GET 请求却因为 DNS 解析失败、超时或信号突然丢失而失败。

### 解决方案：挂起队列与指数退避重试

如果 HTTP 拉取失败，客户端决不能直接丢弃该通知。

1. **防抖与挂起：** 当 `MSG_NOTIFY` 到达时，提取 `SyncSeqId`。如果它大于 `MaxLocalSyncSeqId`，将其存入内存的“待同步 (Pending Sync)”变量中。
2. **执行 HTTP 同步：** 尝试发起 HTTP 请求。
3. **处理失败：** 如果 HTTP 请求报错，保留目标 `SyncSeqId`。使用**指数退避 (Exponential Backoff)** 算法（如 1s, 2s, 4s, 8s）触发重试。
4. **信令合并：** 如果在等待重试的期间，又收到了新的 `MSG_NOTIFY`，只需将“待同步”变量更新为收到的最大 `SyncSeqId` 即可。下一次 HTTP 拉取将会把到最新进度为止的所有缺失消息一并拿回。

## 场景三：乱序到达与重复拉取 (并发竞态)

在极度弱网下，客户端可能会收到延迟的 `MSG_NOTIFY`，或者用户在后台 HTTP 同步正在进行时手动下拉刷新，导致竞态条件。

### 解决方案：客户端去重与同步锁

1. **请求锁 (Sync Lock)：** SDK 必须维护一个 `isSyncing` 布尔锁。如果当前正有一个 HTTP 同步请求在飞行中 (In-Flight)，应忽略新到达的 `MSG_NOTIFY` 触发，直到当前请求完成。
2. **幂等存储：** 由于 NATS 的“至少投递一次”语义或重复的 HTTP 拉取，服务端可能会返回同一条消息多次。
3. **基于 `ClientMsgId` 去重：** 在将拉取到的消息插入本地 SQLite/IndexedDB 数据库之前，客户端**必须**检查 `ClientMsgId` 是否已存在。

```javascript title="客户端去重逻辑"
for (const msg of httpResponse.messages) {
  const exists = await localDB.messages.findOne({ clientMsgId: msg.clientMsgId });
  if (!exists) {
    await localDB.messages.insert(msg); // 仅在不存在时插入
  }
}
// 只有在数据安全入库后，才能更新本地的游标
await localDB.cursors.update({ seqId: maxReceivedSeqId });
```

## 场景四：乐观 UI 卡在“发送中”

用户发送了一条消息 (`MSG_UP`)，但 WebSocket 在收到 `MSG_UP_ACK` 之前就断开了。然而，服务端其实已经成功将消息落库。

### 解决方案：基于 HTTP 同步的状态转正

1. UI 乐观地显示一个“转圈圈”的发送中状态。
2. 网络恢复，客户端自动重连。
3. 按照场景一的规则，客户端隐式发起 HTTP Sync 同步。
4. HTTP 响应中包含了用户刚才发送的那条消息实体。
5. **状态修正：** SDK 通过匹配下发消息的 `ClientMsgId` 和本地卡在 `SENDING` 状态的假消息，使用服务端正式的 `SyncSeqId` 覆写本地记录，并将状态修改为 `SENT`，UI 上的转圈圈瞬间消失。

## 预期结果

通过将 WebSocket 严格视为一条允许丢失的弱状态通知通道，并将 `SyncSeqId` 游标作为 HTTP 数据拉取的绝对幂等凭证，你的客户端 SDK 将能够优雅地抵御极其恶劣的网络抖动。这种架构从根本上杜绝了消息丢失，并消除了 UI 上令人沮丧的无限等待状态。
