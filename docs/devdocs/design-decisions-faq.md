---
id: design-decisions-faq
title: Design Decisions & Architecture FAQ
sidebar_label: Decisions & FAQ
description: Deep dive into the core architectural decisions of Ocean Chat, covering NATS JetStream, event-driven authorization, memory safety, and high-concurrency messaging patterns.
keywords:
  [
    ocean chat,
    architecture,
    nats,
    jetstream,
    event-driven,
    microservices,
    faq,
    design decisions,
    high concurrency,
    zero-io auth,
    memory safety,
  ]
---

import DecisionCard from '@site/src/components/DecisionCard';

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="Design Decisions & Architecture FAQ | Ocean Chat" />
  <meta property="og:description" content="Deep dive into the core architectural decisions of Ocean Chat, covering NATS JetStream, event-driven authorization, and 10M+ concurrency patterns." />
  <link rel="canonical" href="https://docs.oceanchat.com/docs/devdocs/design-decisions-faq" />
</head>

# Design Decisions & FAQ

This document provides a technical deep dive into the architectural rationale behind Ocean Chat. As the system scales to support **10 million concurrent connections**, every design choice is engineered for deterministic performance, resource efficiency, and absolute safety.

## NATS & Event-Driven Architecture

<DecisionCard 
  title="Why isolate AUTH_STATE and AUTH_EVENTS into separate streams?" 
  category="NATS" 
  severity="critical"
  summary="Strictly isolate Control Plane (revocations) from Data Plane (logins) to protect security signals from business traffic surges."
>

In NATS JetStream, a Stream is a lightweight logical construct. The true cost lies in network bandwidth and CPU cycles during consumption. We enforce strict isolation for three reasons:

1.  **Retention Lifecycles**: `AUTH_STATE` (revocations) is transient and lives in high-speed **Memory Storage** (~15-30 min window). `AUTH_EVENTS` (business logins) requires long-term auditing and persists in **File Storage** (SSD) for days.
2.  **Noise Isolation**: Gateways consume `AUTH_STATE` via **Fan-out Broadcast**. Merging them would force every node to process and discard thousands of irrelevant business events per second, causing CPU spikes.
3.  **Critical Path Protection**: Security commands like `auth.jwt.revoke` are red-line critical. Physical isolation ensures that business data surges never delay global security enforcement.

</DecisionCard>

<DecisionCard 
  title="Why publish loggedIn events via NATS instead of direct RPC?" 
  category="NATS" 
  severity="important"
  summary="Eliminate synchronous blocking from the critical login path and enable infinite scalability for downstream consumers."
>

1.  **Extreme Decoupling**: The Auth Service remains unaware of downstream consumers (Presence, Analytics, etc.).
2.  **Zero Synchronous Blocking**: To support 10M+ concurrency, the login API must respond in `< 50ms`. NATS removes all downstream network I/O from the critical path.
3.  **Traffic Shaping**: During massive surges (e.g., global push notifications), NATS buffers events on disk, allowing downstream services to pull data at their maximum safe rate without crashing.

</DecisionCard>

<DecisionCard 
  title="Why use the Modern NATS Consumer API over js.subscribe()?" 
  category="NATS" 
  summary="Leverage Ephemeral Ordered Consumers for better reliability and align with the Node.js event loop using async iteration."
>

1.  **Ephemeral Ordered Consumers**: Automatically handles sequence tracking and sequence resets during network reconnects without manual server-side management.
2.  **Async Iteration (consume())**: Aligns perfectly with the Node.js event loop using `for await`, ensuring non-blocking consumption.

</DecisionCard>

## Performance & Memory Safety

<DecisionCard 
  title="Why use a custom BoundedPublisherService instead of p-limit?" 
  category="Performance" 
  severity="critical"
  summary="Prevent V8 Heap Memory OOM by enforcing hard limits on the task backlog and prioritizing critical security traffic."
>

Standard concurrency libraries like `p-limit` use an **unbounded internal array** for task backlogs. Under extreme load, this array consumes the V8 heap until an **OOM (Out of Memory)** crash occurs. Our custom solution provides:

- **Bounded Backpressure**: Enforces a `maxQueueSize`. Once reached, non-critical tasks are proactively dropped to maintain system stability.
- **Quota Isolation**: Prioritizes critical security signals over business events, preventing "head-of-line" blocking during traffic peaks.

</DecisionCard>

<DecisionCard 
  title="Why enforce a strict 'POJO-only' policy in Repositories?" 
  category="Performance" 
  severity="important"
  summary="Reduce Garbage Collection (GC) pressure and CPU overhead by entirely bypassing Mongoose Document instantiation."
>

Mongoose `Document` instances are heavy classes with complex internal state. At 10M+ scale, they trigger massive Garbage Collection (GC) pressure.

- **Read Operations**: Use `.lean()` to bypass Document instantiation at the driver level.
- **Write Operations**: Immediately call `.toObject()` before returning to the Service layer.

</DecisionCard>

<DecisionCard 
  title="Why perform 'Zero-Trust' validation on internal NATS messages?" 
  category="Safety" 
  summary="Treat internal infrastructure as an untrusted source to prevent malformed data from corrupting the primary database."
>

We treat internal infrastructure as an untrusted source for data integrity.

1.  **Strict Typing**: Every message passes through `class-transformer` and `class-validator` to prevent malformed data (e.g., `Invalid Date`) from corrupting MongoDB.
2.  **ACK/NAK Routing**: Validation failures are immediately `ack()`'d to prevent infinite redelivery loops, while business/DB failures are `nak()`'d to trigger retries.

</DecisionCard>

## Caching Strategy

<DecisionCard 
  title="Authorization Cache Eventual Consistency" 
  category="Caching" 
  severity="important"
  summary="Adopt L1/L2 dual-tier caching with a 10s TTL to protect MongoDB/Redis from request tidal waves."
>

Querying MongoDB or Redis for every permission check is impossible at our scale. We use a two-tier strategy in `RoleCacheService`:

1.  **L1 Memory Cache (Local)**: LRU cache in each Node.js instance (10,000 entries, 10s TTL).
2.  **L2 Distributed Cache (Redis)**: Shared cache protected by jittered distributed locks.

:::warning Security Implication: Eventual Consistency
Permission changes (e.g., revoking a member) take up to **10 seconds** to propagate globally. We accept this trade-off to achieve sub-millisecond local resolution and zero network overhead for the vast majority of requests.
:::

</DecisionCard>

## Messaging Architecture

<DecisionCard 
  title="Control Plane vs Data Plane" 
  category="Messaging" 
  severity="important"
  summary="Use Pure WebSocket for high-frequency signaling and Hybrid HTTP/WS for rich media to prevent pipeline blocking."
>

### Control Plane: Pure Long Connection
The `MSG_UP` command allows sending text directly over the WebSocket/TCP channel.
- **Overhead Compression**: Uses a fixed 12-byte binary header + Protobuf, eliminating the massive overhead of HTTP headers.
- **Smart Keep-Alive**: Every upstream message refreshes the connection TTL, allowing the client to skip dedicated PING heartbeats and save mobile battery.

### Data Plane: Hybrid Connections
For rich media (images, voice), we avoid saturating the WebSocket pipeline:
1.  **Upstream (HTTP)**: Clients upload chunks to OSS via standard HTTP `POST`/`PUT`.
2.  **Downstream (WebSocket)**: The client delivers an ultra-lightweight Protobuf notification (URL + metadata) via `MSG_UP` for the gateway to push.

</DecisionCard>

<DecisionCard 
  title="Statelessness & Idempotency" 
  category="Messaging" 
  summary="Architect for absolute horizontal scaling and full-chain idempotency to survive network jitter and traffic surges."
>

- **Stateless Gateway**: `oceanchat-ws-gateway` is a pure byte-stream packer. Business logic is isolated in the routing layer.
- **Full-Chain Idempotency**: Every message has a unique `ClientMsgId`. Redis Sets enforce strict deduplication, even if network jitter causes client-side re-transmissions.
- **Push-Pull Hybrid**: For massive groups, we send a lightweight `MSG_NOTIFY`. Clients pull content via `SYNC_REQ` to avoid saturating global outbound bandwidth.

</DecisionCard>
