---
id: push-pull-message-delivery-strategy
title: Uniform Push-Pull Strategy for Message Notify
description: Architecture Decision Record explaining the rejection of payload-based dynamic routing in favor of a uniform Push-Pull strategy for message delivery.
keywords:
  [
    ocean chat,
    adr,
    decision-record,
    push-pull,
    websocket,
    http,
    message delivery,
    architecture,
  ]
image: https://docs.oceanchat.com/img/social-card.png
---

# ADR: Uniform Push-Pull Strategy for Message Delivery

## Status

Accepted

## Date

2026-05-07

## Context

Deciding how to deliver messages to clients, whether they are online or offline.

Initially, "payload-based dynamic routing" (or large/small packet shunting) was considered. The strategy would involve the backend checking if the synced messages are fewer than 10 or smaller than 1KB in total. If this condition is met, the messages would be pushed directly over the long connection. Otherwise, a combination of long connection notifications and HTTP short connection pulls would be used.

Intuitively, since a few pure text messages only amount to a few hundred bytes, pushing them directly through the long connection saves the overhead of an HTTP handshake (RTT), and the perceived latency for the user would indeed be lower. Many early IM systems or scenarios that demand extreme real-time performance but have lower reliability requirements (such as live stream bullet chats or in-game public chats) adopt this exact approach.

However, in a massive-scale IM architecture that pursues "absolute zero loss" and "massive concurrency", architects must carefully weigh these options.

## Decision

Reject payload-based dynamic routing. Use a uniform **Push-Pull strategy** (lightweight long-connection notifications combined with HTTP short-connection data pulls) to guarantee message consistency and reliability, regardless of whether the message is online or offline, and regardless of the payload size.

## Alternatives Considered

### Payload-Based Dynamic Routing (Push for small payloads, Pull for large)

- **Pros:** Lower perceived latency for small text messages by eliminating the HTTP handshake RTT.
- **Cons:** This approach introduces several fatal architectural hazards in an ultra-large-scale distributed system:
  1. **Destroys Gateway Statelessness:** The secret to a long-connection gateway (WebSocket/TCP Gateway) handling tens of millions of concurrent connections is being "dumb"—it only maintains the network channel and does not care about the business logic. If this strategy were adopted, the gateway or push service must inspect the payload: count the messages and calculate their total size. Once the gateway couples with business data length and quantity, CPU consumption multiplies. A machine that could handle 1,000,000 connections might drop to handling only 100,000.
  2. **The ACK (Acknowledgment) Nightmare:** The hardest part of an IM system is proving delivery. A pure Pull model is extremely elegant: the client requests `Sync(seq=100)`, and the server returns `101-105`. The next time the client requests with `Sync(seq=105)`, the server knows implicitly that the previous messages were received. No extra ACK packets are needed. If data is pushed directly via the long connection and the user's phone enters an elevator and loses the network, the data dies in transit. To guarantee no loss, the long connection must introduce a complex ACK and timeout retransmission mechanism. This makes the long connection incredibly heavy and entangles the network layer with the business layer.
  3. **State Machine Explosion Due to Protocol Forking:** Maintaining a unified logic is always safer than maintaining two conditional branches. This strategy creates two entirely different delivery paths:
     - _Scenario A:_ User online, message < 1KB ➔ Long-connection Push.
     - _Scenario B:_ User offline, or message > 1KB ➔ HTTP Pull.
     - _Scenario C (The worst edge case):_ User is in a "weak network environment". The server pushes half the data over the long connection, TCP drops; simultaneously, the client switches to a strong 4G network and immediately initiates an HTTP Pull. Should the server retransmit the Push or respond to the Pull? Data easily becomes duplicated, out of order, or deadlocked.
  4. **Inability to Withstand Group Chat Concurrency Storms:** Imagine an active 500-person group where members are grabbing red packets, instantly generating 10 short messages (< 1KB). The server pushes data to these 500 people simultaneously via the long connection. In that instant, the long-connection cluster sends out 5,000 actual data packets, causing bandwidth and CPU to spike. Alternatively, using "lightweight notifications + decentralized client pulls", paired with HTTP CDNs and caching, scatters the pressure and keeps the system much more stable.

- **Rejected:** The severe architectural risks and complexity far outweigh the minor latency benefits.

## Consequences

- The WebSocket/TCP gateway remains absolutely stateless and highly performant.
- Client state machine logic is significantly simplified: always pull data upon receiving a lightweight notification.
- Eliminates the need to implement and maintain complex business-level ACK and timeout retransmission logic over the long-connection layer.
- Enhances system resilience against group chat concurrency storms by leveraging HTTP CDNs, API Gateways, and Redis caching to absorb the read pressure.
- A slight overhead (HTTP RTT) is incurred for small messages, which is an acceptable and necessary trade-off to achieve absolute reliability and massive scale.
