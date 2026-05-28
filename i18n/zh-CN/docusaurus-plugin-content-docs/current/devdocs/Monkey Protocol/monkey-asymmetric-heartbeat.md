---
id: monkey-asymmetric-heartbeat
title: 非对称时间差心跳与保活设计
description: 深度解析 Monkey Protocol 中基于“非对称时间差”与“任何业务包即心跳”的高性能长连接保活机制。
keywords: [ocean chat, monkey protocol, websocket, 心跳机制, 高并发, 架构设计]
sidebar_position: 2
tags: ["ocean-chat", "specification", "architecture", "websocket"]
---

# 非对称时间差心跳与保活设计

在构建支撑十万级并发连接的 IM 平台（Ocean Chat）时，如何高效、低成本地维持 `oceanchat-ws-gateway` 与海量客户端之间的长连接存活状态，是一个极其关键的底层挑战。

Monkey Protocol 摒弃了传统的“客户端固定频率发送 PING、服务端无脑回复 PONG”的僵化模式，引入了**非对称时间差 (Asymmetric Time Difference)** 与 **任何消息即心跳 (Implicit Heartbeat)** 机制。

本文档详细规定了该机制的底层原理、状态机设计以及客户端/服务端的最佳实现约束。

---

## 1. 传统心跳机制的痛点

在传统的长连接保活设计中，通常由客户端每隔 N 秒发送一个 PING，服务端收到后回复 PONG。
这种模式在十万级并发下存在严重的资源浪费：

1. **双向信令浪费**：在连接完全空闲时，客户端和服务端如果各自维护一套独立的心跳定时器，极易发生“几乎在同一毫秒互相向对方发送 PING”的碰撞，白白浪费了一半的网络下行带宽和网关 CPU 解析开销。
2. **活跃期冗余**：当用户正在高频聊天（收发 `MSG_UP` 和 `MSG_NOTIFY`）时，底层的定时器依然在雷打不动地发送 PING/PONG，这完全是画蛇添足。

---

## 2. 核心机制一：非对称时间差设计 (Asymmetric Interval)

为了彻底解决“双向 PING 碰撞”引起的带宽浪费，Monkey Protocol 在协议规范上对客户端和服务端的默认空闲心跳间隔（Interval）进行了**故意错开**的设计：

- **服务端 (`oceanchat-ws-gateway`) PING 间隔**：`30 秒`
- **客户端 (Mobile/Web SDK) PING 间隔**：`35 秒`
- **双端绝对超时断线时间 (Timeout)**：`60 秒`

### 2.1 设计精妙之处

因为服务端的定时器步长（30s）始终比客户端（35s）短，所以在连接绝对空闲（没有任何业务数据交互）的情况下：
**永远都是服务端先触发 PING (`[0x03] PING`)。**

1. 第 30 秒：服务端向客户端发送 `PING`。
2. 客户端收到服务端的 `PING`，立刻回复 `PONG (`[0x04] PONG`)`。
3. **关键点**：客户端在收到服务端的任何数据包（包括这个 PING）时，都会**重置自己本地的 35 秒 PING 定时器**。
4. 因此，只要网络正常，客户端的 35 秒定时器永远等不到触发的那一刻，从而完美避免了双向同时发送心跳包造成的带宽浪费。在空闲状态下，维持一条长连接只需要单向发起探测即可。

### 2.2 客户端兜底

为什么客户端还要保留 35 秒的定时器？
这是为了**容错 (Fallback)**。如果下行网络异常，服务端发送的 `PING` 丢失了，客户端的定时器走到 35 秒时，就会主动发出 `PING`，尝试唤醒连接或尽早发现死链，以便启动重连状态机。

---

## 3. 核心机制二：任何消息即心跳 (Any Message is PONG)

Monkey Protocol 深度贯彻“流量复用”的原则。不论是 PING/PONG 帧，还是实际的业务包（如 `[0x05] MSG_UP`、`[0x08] MSG_NOTIFY`），**任何合法的底层网络传输都足以证明双端的连通性**。

### 3.1 网关层 (Server) 的处理逻辑

- 网关为每个 WebSocket 连接在内存中维护一个极轻量的属性：`lastActiveTime`（最后活跃时间戳，精确到毫秒）。
- 当网关接收到来自该客户端的**任何 Monkey Protocol 帧**（无论指令是 `AUTH_REQ`、`MSG_UP`、`PING` 还是 `PONG`）：
  - 必须立刻执行 `client.lastActiveTime = Date.now()`。
  - **专门针对 `[0x03] PING` 的处理逻辑**：网关必须立即向客户端回复一个无 Payload 的 `[0x04] PONG` 帧。这是为了响应客户端在弱网下的主动探活（客户端的 35 秒容错兜底）。
  - **专门针对 `[0x04] PONG` 的处理逻辑**：在业务层实际上是**空操作 (noop)**。因为它存在的唯一价值就是触发第一步的刷新时间戳行为。

### 3.2 客户端 (Client SDK) 的处理逻辑

- 与服务端一致，客户端 SDK 在收到服务端的**任何 Monkey Protocol 帧**（无论是 `AUTH_ACK`、`MSG_UP_ACK`、`MSG_NOTIFY`、`PING` 还是 `PONG` 等）时，都应视其为隐式的 PONG，必须立即重置本地的“发送 PING”和“绝对超时断线”倒计时。
- **专门针对 `[0x03] PING` 的处理逻辑**：无论当前业务多繁忙，只要明确收到了指令为 `[0x03] PING` 的帧，客户端底层网络模块必须立即向服务端回复一个无 Payload 的 `[0x04] PONG` 帧，以配合服务端的探活机制。
- **专门针对 `[0x04] PONG` 的处理逻辑**：与服务端同理，在业务层为**空操作 (noop)**，仅用于触发第一步的倒计时重置。

---

## 4. 服务端 (Gateway) 大规模心跳实现规范：Sweep 轮询机制

对于承载了 10 万+ 连接的单个 `oceanchat-ws-gateway` 实例，**绝对禁止**为每个连接创建独立的 `setTimeout` 或 `setInterval` 定时器实例，这会导致严重的 Node.js 事件循环（Event Loop）阻塞和内存溢出。

网关采用**全局扫描 (Sweep/Tick)** 机制：

```typescript
// 伪代码逻辑演示，应在网关中作为一个全局单例执行
setInterval(() => {
  const now = Date.now();
  const idlePingThreshold = 30000; // 30 秒未活跃，发 PING
  const deadTimeoutThreshold = 60000; // 60 秒未活跃，判定死亡

  for (const client of globalConnectionPool.values()) {
    const idleTime = now - client.lastActiveTime;

    if (idleTime >= deadTimeoutThreshold) {
      // 1. 超时强杀，防止僵尸连接占用 FD
      client.terminate();
      // 2. 触发向 Redis Presence 中心的离线事件清理
      triggerPresenceOffline(client);
    } else if (idleTime >= idlePingThreshold && !client.pingSent) {
      // 超过 30 秒空闲，发送探测 PING
      client.sendMonkeyFrame(Cmd.PING);
      client.pingSent = true;
    }
  }
}, 5000); // 全局每 5 秒扫描一次即可，牺牲一点点精度换取极大的性能提升
```

_说明：当收到任何消息刷新 `lastActiveTime` 时，同时将 `pingSent` 重置为 `false`。_

---

## 5. 客户端 SDK 容错状态机与飞行队列补偿

客户端不仅要配合服务端的心跳探测，还要管理复杂的断网重连和数据补偿。这是保障 C 端用户体验（弱网不丢消息）的防线。

### 5.1 指数退避重连 (Exponential Backoff)

当客户端通过超时机制（超过 60 秒未收到服务端任何数据）检测到死链，或收到 `[0x0C] EXCEPTION_ACK` 异常断线后：

- **禁止立刻重连**：必须带有随机抖动的指数退避逻辑（如 `Math.random() * (2^retryCount * 1000)`，最大上限 30 秒）。防止服务器发生网络闪断时，十万级客户端瞬间发起重连，形成“雷群效应”压垮 `oceanchat-auth`。

### 5.2 飞行中队列 (In-Flight Queue) 自动重放

这是 Monkey Protocol 在 SDK 层对可靠性至关重要的设计：

1. **入列**：任何带有 `ReqId` 且非 0 的业务请求（如 `[0x05] MSG_UP`），在发出时，连同其 Payload 及发起时间，存入内存的 `In-Flight Queue` 中。
2. **出列**：当收到带有相同 `ReqId` 的 `[0x06] MSG_UP_ACK` 响应时，将其从飞行队列移除。
3. **重放机制 (Replay)**：一旦发生意外断线，底层的状态机会在重连且 `AUTH_REQ` 成功认证后，**自动、静默地**将 `In-Flight Queue` 中的所有遗留包按顺序重新发送一遍。
4. **幂等兜底**：因为重放的 Payload 中包含了原封不动的 `ClientMsgId`，所以即便服务端在断网前已经处理并入库了这条消息（只是 ACK 没来得及下发），服务端的去重机制也能安全过滤，绝不会在群里发两遍一模一样的内容。

### 5.3 No-Retry 标志扩展位

针对高频但时效性极强的非关键信令（例如“对方正在输入...”），如果在队列中因为断网卡了几秒钟，重连后再发已经毫无意义。
在封装 `MSG_UP` 时，客户端可以在 Monkey Protocol Header 的 `Flags` 字段中设置特殊的 `NO_RETRY` 位（例如 Bit 3）。
当重放队列被唤醒时，底层拦截器直接丢弃带有 `NO_RETRY` 标志的数据包，进一步节省断网恢复瞬间的网络风暴带宽。

---

## 6. 总结

Monkey Protocol 的保活机制并不只是简单的 PING/PONG，它是与整体业务模型深度融合的：

1. **非对称定时器**：利用 30s 与 35s 的时间差，巧妙消除了连接空闲期的约 50% 冗余带探测心跳。
2. **全协议复用**：将所有的底层控制帧与业务流混流计入心跳活跃期，实现了活跃聊天期间的“零 PING 包损耗”。
3. **网关宏观轮询**：摒弃 per-socket 计时器，将百万级连接的心跳调度降维到单线程 O(N) 宏观扫描，解放了 CPU。
4. **飞行补偿闭环**：通过隐式心跳发现死链，触发指数重连，并在重连后对未确认信令执行安全重放。

这些机制的结合，是保证 `oceanchat-ws-gateway` 能够稳定运行在十万级并发节点、即使在地铁、电梯等弱网频发环境中依然保持强劲的信令触达率的基石。
