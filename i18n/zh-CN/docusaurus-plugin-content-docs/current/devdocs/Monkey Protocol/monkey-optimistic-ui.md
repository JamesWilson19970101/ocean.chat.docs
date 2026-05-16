---
id: monkey-optimistic-ui
title: 乐观 UI (Optimistic UI) 的辅助设计与客户端实现规范
description: 详细规范在使用 Monkey Protocol 时，客户端 SDK 如何配合协议字段实现零延迟的乐观 UI 渲染与状态回环。
keywords:
  [ocean chat, monkey protocol, optimistic ui, 乐观 UI, 状态机, 弱网体验]
sidebar_position: 4
tags: ["ocean-chat", "specification", "architecture", "frontend", "client-sdk"]
---

# 乐观 UI (Optimistic UI) 的辅助设计

在 C 端即时通讯（IM）产品中，用户体验的最高境界是**“永远感觉不到网络延迟”**。当用户点击“发送”按钮时，消息气泡应当在 1 毫秒内出现在聊天屏幕上，而不是等待几百毫秒的网络往返（RTT）后才显示。

这种“先渲染、后确认”的机制被称为**乐观 UI (Optimistic UI)**。由于 Monkey Protocol 采用服务端统一分配 `SyncSeqId` 的严格时序模型，客户端在乐观渲染时会面临“ID 未知”和“状态回环”的挑战。本文档详细规定了客户端 SDK 如何利用 Monkey Protocol 的底层设计，完美闭环乐观 UI 的渲染与防错。

---

## 1. 核心纽带：`ClientMsgId` (客户端去重与关联种子)

在 Monkey Protocol 中，`SyncSeqId`（64位长整型）是会话中绝对权威的消息游标，且由 `oceanchat-message` 服务端单调递增分配。这意味着客户端在发送消息的一瞬间，是**绝对不知道**这条消息最终的 `SyncSeqId` 的。

乐观 UI 的基石在于 **`ClientMsgId` (通常为 UUID)**：

1. **发送前生成**：当 UI 层触发发送动作时，客户端 SDK 立刻生成一个全局唯一的 `ClientMsgId`。
2. **双重身份**：
   - **对于服务端**：它是实现高并发幂等性（Idempotency）的唯一凭证（写入 Redis 防止断网重试导致的重复落库）。
   - **对于客户端**：它是串联起“本地假状态”与“服务端真状态”的**唯一纽带 (Anchor)**。

---

## 2. 客户端本地存储 (Local DB) 的状态机设计

为了支撑乐观 UI，客户端的本地数据库（如 SQLite / IndexedDB）中，消息表（`Message`）必须具备以下三个关键字段：

- `client_msg_id`: (String, 唯一索引) 客户端生成。
- `sync_seq_id`: (Int64, 允许为空) 服务端生成的最终游标。
- `send_status`: (Enum) 本地发送状态，包含 `SENDING (发送中)`, `SENT (已发送)`, `FAILED (发送失败)`。

### 2.1 状态转换：发送的瞬间 (Optimistic Render)

当用户点击发送：

1. UI 组装富文本或文字数据，调用 SDK。
2. SDK 生成 `ClientMsgId = "uuid-1234"`。
3. SDK **立即**将该消息写入本地 DB：
   - `client_msg_id = "uuid-1234"`
   - `sync_seq_id = null` (或设为一个极大的本地假 ID 以保证排序在最底部)
   - `send_status = SENDING`
   - `created_at = Date.now()`
4. **UI 响应**：本地数据库的变化立即通过响应式流（如 RxJS, Flow, LiveData）推送到界面。消息气泡出现在屏幕最下方，旁边伴随一个“转圈圈”的发送中图标。

---

## 3. 协议回环：状态修正的 3 种路径

消息通过 Monkey Protocol 的 `[0x05] MSG_UP` 发出后，客户端会遇到三种不同的协议回环场景。SDK 必须对这三种场景进行准确的拦截与状态修正。

### 路径 A：完美路径（收到 `MSG_UP_ACK`）

服务端极速处理完成，越过写屏障后，通过原 TCP/WS 连接下发 `[0x06] MSG_UP_ACK`。

1. **匹配 ReqId**：客户端底层拦截器通过 12 字节 Header 中的 `ReqId` 找到了这是刚才发送的哪条底层网络请求。
2. **获取服务端状态**：`MSG_UP_ACK` 的 Payload 中携带了服务端为其分配的官方 `SyncSeqId`（如 `1005`）和服务器的 `ServerTimestamp`。
3. **更新 DB (状态转正)**：SDK 根据 `ReqId` 反查出 `ClientMsgId`，更新本地数据库：
   - `send_status -> SENT`
   - `sync_seq_id -> 1005`
4. **UI 响应**：“转圈圈”图标消失，乐观渲染完美闭环。

### 路径 B：边缘降维路径（ACK 丢失，但通过 `MSG_NOTIFY` 找回）

在极端弱网下，客户端发送的 `MSG_UP` 成功到达服务器并入库，但在服务器返回 `MSG_UP_ACK` 时网络断开了。
此时，客户端的乐观 UI 依然卡在 `SENDING` 状态。

1. **断线重连与隐式拉取**：网络恢复后，客户端自动重连。如果群里有新消息，服务器下发 `[0x08] MSG_NOTIFY`，客户端触发 HTTP 短连接的增量拉取（`Sync`）。
2. **遭遇自己的消息**：在 HTTP 接口返回的增量消息列表中，客户端遍历并解析到了自己刚才发的那条消息实体。
3. **ClientMsgId 融合拦截**：SDK 在将新消息插入 DB 之前，必须做一次强校验：
   - 检查 `Message.client_msg_id` 是否在本地 DB 中已存在。
   - 如果存在且 `send_status == SENDING`，说明**这是自己刚才发的、ACK 丢了的消息**。
4. **更新 DB (状态转正)**：SDK 不插入新行，而是直接 `UPDATE` 本地那条处于 `SENDING` 状态的假消息，将其 `sync_seq_id` 覆写为真实 ID，`send_status` 设为 `SENT`。

### 路径 C：异常拦截路径（收到 `EXCEPTION_ACK`）

由于包含敏感词、被对方拉黑、或者 token 恰好过期，网关主动下发了 `[0x0C] EXCEPTION_ACK`。

1. **匹配 ReqId**：同样通过 Header 的 `ReqId` 找到对应的请求拦截器。
2. **更新 DB (状态失败)**：
   - `send_status -> FAILED`
3. **UI 响应**：“转圈圈”图标变成一个红色的感叹号 `!`。用户点击感叹号可提示服务器返回的具体错误原因（`ExceptionAck.message`）。

---

## 4. 与“飞行中队列 (In-Flight Queue)”的深度协同

前文设计了**断网时的飞行队列自动重放机制**。这与乐观 UI 是天作之合。

当用户进入地铁（断网）并发了一条消息：

1. UI 执行乐观渲染，状态为 `SENDING`。
2. 底层网络发现死链，消息存入内存的 `In-Flight Queue` 中。
3. 用户切出 App 或关闭屏幕。只要进程没被杀，消息就在队列里静静等待。
4. **UI 表现**：这期间，无论过去多久，UI 上依然保持 `SENDING`（或超时后变为类似“网络等待中...”的样式），**绝对不能轻易将其标记为 `FAILED`**，因为底层接管了重放权。
5. 网络恢复后，`In-Flight Queue` 自动将包带上原本的 `ReqId` 和 `ClientMsgId` 发出。收到 ACK 后，UI 的 `SENDING` 自动转正。这种极致的容错让用户感到无比省心。

---

## 5. 高级：复杂业务实体的乐观 UI 预生成 (Optimistic Entity Allocation)

乐观 UI 不仅仅局限于发送文本消息，还可以应用到诸如“创建群聊”、“发送多图”等复杂交互中。

Monkey Protocol 倡导**“客户端作为 ID 的预先分配者”**（通过哈希或 UUID 降维）：

- **发送长视频**：
  1. 视频尚未开始上传 OSS，SDK 就预先生成一个 `ClientMsgId` 插入本地 DB。
  2. UI 层利用这个假数据直接在对话列表渲染出一个进度为 `0%` 的视频气泡。
  3. 等待 HTTP 上传完成、长连接 `MSG_UP` 控制面通知下发后，再由 `SENDING` 变更为 `SENT`。
- **临时排序权重**：
  乐观消息因为没有真实的 `SyncSeqId`，本地 DB 查询时如何保证它排在对话最底部？
  **最佳实践**：在 SQLite 的查询中采用类似 `ORDER BY COALESCE(sync_seq_id, 999999999999999) + created_at ASC` 的逻辑。利用 `COALESCE` 赋予没有正式 ID 的乐观消息极高的虚拟权重，确保它总是粘在当前聊天流的最末尾。

---

## 6. 总结

基于 Monkey Protocol 的乐观 UI 并非毫无章法的“前端欺骗”，而是一套精密配合的数据闭环：

1. **`ClientMsgId` 是核心锚点**，用于关联服务端未决数据与本地临时数据。
2. 本地数据库的 **`SENDING` 状态** 是桥接长链接控制面 (`MSG_UP_ACK`) 与短链接数据面 (`Sync`) 的过渡态。
3. 结合**飞行队列重放**与**服务端幂等去重**，我们在弱网环境下实现了“发后即忘 (Fire and Forget)”，且永远不会产生重复气泡或幽灵消息。
