---
id: monkey-asymmetric-heartbeat
title: Asymmetric Heartbeat and Keep-alive Design
description: Deep dive into the high-performance long-connection keep-alive mechanism in Monkey Protocol based on "Asymmetric Time Difference" and "Any Message is Heartbeat".
keywords:
  [
    ocean chat,
    monkey protocol,
    websocket,
    heartbeat mechanism,
    high concurrency,
    architecture design,
  ]
sidebar_position: 2
tags: ["ocean-chat", "specification", "architecture", "websocket"]
---

# Asymmetric Heartbeat and Keep-alive Design

When building an IM platform (Ocean Chat) that supports tens of millions of concurrent connections, efficiently and cost-effectively maintaining the keep-alive state of long connections between `oceanchat-ws-gateway` and a massive number of clients is a critical underlying challenge.

Monkey Protocol abandons the traditional, rigid "client sends PING at a fixed frequency, server brainlessly replies PONG" model. Instead, it introduces the **Asymmetric Time Difference (Asymmetric Interval)** and **Any Message is Heartbeat (Implicit Heartbeat)** mechanisms.

This document specifies the underlying principles, state machine design, and best implementation constraints for both client and server.

---

## 1. Pain Points of Traditional Heartbeat Mechanisms

In traditional keep-alive designs, the client typically sends a PING every N seconds, and the server replies with a PONG upon receipt.
This model suffers from serious resource waste at a scale of tens of millions of concurrent connections:

1. **Bidirectional Signaling Waste**: When a connection is completely idle, if both the client and server maintain independent heartbeat timers, collisions where they "send PING to each other at almost the same millisecond" are highly likely. This wastes half of the network downlink bandwidth and gateway CPU parsing overhead.
2. **Redundancy During Active Periods**: When users are chatting frequently (sending/receiving `MSG_UP` and `MSG_NOTIFY`), the underlying timers continue to send PING/PONG rigidly, which is completely redundant.

---

## 2. Core Mechanism 1: Asymmetric Interval Design

To thoroughly solve the bandwidth waste caused by "bidirectional PING collisions," Monkey Protocol intentionally staggers the default idle heartbeat intervals for the client and server in the protocol specification:

- **Server (`oceanchat-ws-gateway`) PING Interval**: `30 seconds`
- **Client (Mobile/Web SDK) PING Interval**: `35 seconds`
- **Absolute Timeout/Disconnection Time for Both Ends**: `60 seconds`

### 2.1 The Elegance of the Design

Since the server's timer step (30s) is always shorter than the client's (35s), in a situation where the connection is absolutely idle (no business data interaction):
**The server will always be the first to trigger a PING (`[0x03] PING`).**

1. At the 30th second: The server sends a `PING` to the client.
2. The client receives the server's `PING` and immediately replies with a `PONG (`[0x04] PONG`)`.
3. **Key Point**: When the client receives any data packet from the server (including this PING), it **resets its own local 35-second PING timer**.
4. Therefore, as long as the network is normal, the client's 35-second timer will never reach its trigger point, perfectly avoiding bandwidth waste caused by both ends sending heartbeat packets simultaneously. In an idle state, maintaining a long connection only requires one end to initiate probing.

### 2.2 Client Fallback

Why does the client still keep a 35-second timer?
This is for **Fault Tolerance (Fallback)**. If the downlink network is abnormal and the `PING` sent by the server is lost, when the client's timer reaches 35 seconds, it will actively send a `PING` to attempt to wake up the connection or discover a dead link as early as possible, thereby starting the reconnection state machine.

---

## 3. Core Mechanism 2: Any Message is Heartbeat (Any Message is PONG)

Monkey Protocol deeply implements the principle of "traffic multiplexing." Whether it's PING/PONG frames or actual business packets (such as `[0x05] MSG_UP`, `[0x08] MSG_NOTIFY`), **any legitimate underlying network transmission is sufficient to prove the connectivity of both ends**.

### 3.1 Gateway (Server) Processing Logic

- The gateway maintains a very lightweight property in memory for each WebSocket connection: `lastActiveTime` (last active timestamp, accurate to milliseconds).
- When the gateway receives **any Monkey Protocol frame** from the client (regardless of the command: `AUTH_REQ`, `MSG_UP`, `PING`, or `PONG`):
  - It must immediately execute `client.lastActiveTime = Date.now()`.
  - **Specific Logic for `[0x03] PING`**: The gateway must immediately reply to the client with a `[0x04] PONG` frame with no Payload. This is to respond to the client's active probing in weak network conditions (the client's 35-second fallback).
  - **Specific Logic for `[0x04] PONG`**: This is practically a **noop** at the business layer. Its only value is to trigger the timestamp refresh in the first step.

### 3.2 Client (Client SDK) Processing Logic

- Similar to the server, when the client SDK receives **any Monkey Protocol frame** from the server (such as `AUTH_ACK`, `MSG_UP_ACK`, `MSG_NOTIFY`, `PING`, or `PONG`), it should treat it as an implicit PONG and must immediately reset the local "Send PING" and "Absolute Timeout" countdowns.
- **Specific Logic for `[0x03] PING`**: Regardless of how busy the current business is, as long as a frame with command `[0x03] PING` is clearly received, the client's underlying network module must immediately reply to the server with a `[0x04] PONG` frame with no Payload to cooperate with the server's probing mechanism.
- **Specific Logic for `[0x04] PONG`**: Same as the server, this is a **noop** at the business layer, used only to trigger the countdown reset in the first step.

---

## 4. Server (Gateway) Large-Scale Heartbeat Implementation Specification: Sweep Mechanism

For a single `oceanchat-ws-gateway` instance carrying over 100,000 connections, it is **absolutely forbidden** to create independent `setTimeout` or `setInterval` timer instances for each connection. This would lead to severe Node.js Event Loop blocking and memory overflow.

The gateway adopt a **Global Sweep/Tick** mechanism:

```typescript
// Pseudo-code demonstration, should be executed as a global singleton in the gateway
setInterval(() => {
  const now = Date.now();
  const idlePingThreshold = 30000; // 30 seconds idle, send PING
  const deadTimeoutThreshold = 60000; // 60 seconds idle, determine dead

  for (const client of globalConnectionPool.values()) {
    const idleTime = now - client.lastActiveTime;

    if (idleTime >= deadTimeoutThreshold) {
      // 1. Force kill timeout to prevent zombie connections from occupying FDs
      client.terminate();
      // 2. Trigger offline event cleanup in the Redis Presence center
      triggerPresenceOffline(client);
    } else if (idleTime >= idlePingThreshold && !client.pingSent) {
      // Idle for more than 30 seconds, send a probe PING
      client.sendMonkeyFrame(Cmd.PING);
      client.pingSent = true;
    }
  }
}, 5000); // Sweeping once every 5 seconds globally is sufficient, sacrificing a bit of precision for a massive performance boost
```

_Note: When any message is received and `lastActiveTime` is refreshed, `pingSent` should also be reset to `false`._

---

## 5. Client SDK Fault Tolerance State Machine and In-Flight Queue Compensation

The client must not only cooperate with the server's heartbeat probing but also manage complex network disconnection, reconnection, and data compensation. This is the defensive line for ensuring C-end user experience (no message loss in weak networks).

### 5.1 Exponential Backoff Reconnection

When the client detects a dead link through the timeout mechanism (no data received from the server for over 60 seconds) or receives an `[0x0C] EXCEPTION_ACK` abnormal disconnection:

- **Immediate Reconnection is Forbidden**: Exponential backoff logic with random jitter must be implemented (e.g., `Math.random() * (2^retryCount * 1000)`, with a maximum cap of 30 seconds). This prevents tens of millions of clients from initiating reconnections simultaneously when a server network glitch occurs, avoiding the "Thunder Herd Effect" that could crash `oceanchat-auth`.

### 5.2 In-Flight Queue Automatic Replay

This is a critical design for reliability at the Monkey Protocol SDK layer:

1. **Enqueuing**: Any business request with a non-zero `ReqId` (e.g., `[0x05] MSG_UP`), when sent, is stored in the memory's `In-Flight Queue` along with its Payload and initiation time.
2. **Dequeuing**: When a `[0x06] MSG_UP_ACK` response with the same `ReqId` is received, it is removed from the In-Flight Queue.
3. **Replay Mechanism**: Once an unexpected disconnection occurs, the underlying state machine will **automatically and silently** resend all remaining packets in the `In-Flight Queue` in order after reconnection and successful `AUTH_REQ` authentication.
4. **Idempotency Fallback**: Since the replayed Payload contains the original `ClientMsgId`, even if the server had already processed and stored the message before the disconnection (but the ACK didn't make it), the server's deduplication mechanism will safely filter it out, ensuring that the exact same content is never sent twice in a group.

### 5.3 No-Retry Flag Extension Bit

For high-frequency but extremely time-sensitive non-critical signaling (such as "The other party is typing..."), if it gets stuck in the queue for a few seconds due to disconnection, it's meaningless to resend it after reconnection.
When encapsulating `MSG_UP`, the client can set a special `NO_RETRY` bit (e.g., Bit 3) in the `Flags` field of the Monkey Protocol Header.
When the replay queue is awakened, the underlying interceptor directly discards packets with the `NO_RETRY` flag, further saving bandwidth during the network recovery burst.

---

## 6. Summary

Monkey Protocol's keep-alive mechanism is not just a simple PING/PONG; it is deeply integrated with the overall business model:

1. **Asymmetric Timers**: Uses the 30s and 35s time difference to cleverly eliminate about 50% of redundant heartbeat probing during idle periods.
2. **Full Protocol Multiplexing**: Counts all underlying control frames and business flows into the heartbeat active period, achieving "zero PING packet loss" during active chatting.
3. **Gateway Macro Polling**: Abandons per-socket timers, reducing the heartbeat scheduling of millions of connections to a single-threaded O(N) macro sweep, freeing up the CPU.
4. **In-Flight Compensation Loop**: Discovers dead links through implicit heartbeats, triggers exponential reconnection, and performs safe replay of unacknowledged signaling after reconnection.

The combination of these mechanisms is the foundation for `oceanchat-ws-gateway` to run stably on nodes with hundreds of thousands of concurrent connections and maintain strong signaling reach even in weak network environments like subways or elevators.
