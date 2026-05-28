---
id: long-connection-for-message-sending
title: Long-Lived vs Short-Lived Connections for Message Sending
description: Architecture decision record detailing the choice of long-lived connections for message sending to improve performance and reduce power consumption.
keywords:
  [
    ocean-chat,
    adr,
    decision-record,
    websocket,
    tcp,
    long-connection,
    short-connection,
    messaging,
    performance,
    power-saving,
  ]
tags: ["ocean-chat", "adr", "decision-record"]
---

# ADR: Long-Lived Connections for Message Sending

## Status

Accepted

## Date

2026-05-20

## Context

In modern IM systems, clients must transmit messages to the server efficiently. There are two primary transport strategies available:

1. **Short-lived connections (HTTP/REST):** The client opens a new HTTP request for each message, transmits the payload, and closes the connection (or utilizes keep-alive, which still incurs request overhead).
2. **Long-lived connections (WebSocket/TCP):** The client establishes a persistent duplex connection with the server. All real-time message sending and receiving occur over this single established channel.

## Decision

Use **long-lived connections (WebSocket/TCP)** as the primary transport mechanism for sending messages from the client to the server.

## Alternatives Considered

### Short-lived Connections (HTTP API)

- **Pros:**
  - Simple to implement and natively stateless.
  - Leverages existing HTTP infrastructure (API gateways, standard load balancers).
  - Built-in request/response semantics simplify client-side error handling.
- **Cons:**
  - **Protocol Overhead:** Each request requires HTTP headers. Without persistent keep-alive, it also incurs TCP/TLS handshake penalties, significantly increasing latency.
  - **Power Consumption:** Frequent waking of the mobile radio antenna to establish outgoing connections drains the battery severely on mobile devices.
  - **Inconsistent Latency:** Slower initial connection time for messages sent after an idle period.
- **Rejected:** The severe impact on mobile battery life and the unnecessary protocol overhead make this unsuitable for high-frequency chat applications.

### Long-lived Connections (WebSocket / TCP)

- **Pros:**
  - **Power Efficiency:** Maintaining a single persistent connection minimizes radio wake-up states on mobile devices, drastically saving battery life.
  - **High Performance:** Eliminates the overhead of repeated TCP/TLS handshakes and HTTP headers. Messages are framed with minimal bytes, providing ultra-low latency.
  - **Duplex Optimization:** Reuses the established channel for both sending outbound messages and receiving inbound real-time events (e.g., push messages, typing indicators).
- **Cons:**
  - **Stateful Complexity:** Requires robust connection lifecycle management, including application-level heartbeats (ping/pong) and reconnect logic.
  - **Infrastructure Demands:** Gateway load balancers must be configured for long-held connections and proxying WebSocket/TCP traffic.
- **Accepted:** The power savings and latency improvements heavily outweigh the infrastructure complexity.

## Consequences

- **Client Implementation:** The client SDK must implement robust connection management. This includes exponential backoff for reconnects and application-level heartbeats to detect half-open or dead connections.
- **Server Architecture:** The access/gateway tier must be designed as stateful nodes capable of concurrently holding 100K+ of persistent connections (utilizing epoll/kqueue) and rapidly routing inbound messages to backend services.
- **Large Payload Fallback:** While long connections handle real-time text and small payloads, an HTTP REST fallback will be retained for uploading large multimedia files (images, videos) to avoid head-of-line blocking on the primary duplex stream.

:::tip Performance Note
By centralizing message dispatch over the existing long-lived channel, the system sidesteps the classic TCP slow-start phase for subsequent messages, ensuring instantaneous delivery even after brief idle periods.
:::
