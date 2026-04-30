---
id: design-decisions-faq
title: Design Decisions & FAQ
sidebar_label: Decisions & FAQ
description: Explanations of core architectural decisions in Ocean Chat, including NATS JetStream stream isolation and event-driven authentication.
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
  ]
---

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="Design Decisions & FAQ | Ocean Chat" />
  <meta property="og:description" content="Explanations of core architectural decisions in Ocean Chat, including NATS JetStream stream isolation and event-driven authentication." />
  <link rel="canonical" href="https://docs.oceanchat.com/docs/devdocs/design-decisions-faq" />
</head>

# Understanding JetStream Architecture Decisions

This document explains the rationale behind key architectural decisions in the Ocean Chat NATS JetStream integration, focusing on why the system is designed to support 10 million concurrent connections safely and efficiently.

## Why isolate `AUTH_STATE` and `AUTH_EVENTS` instead of using a single Stream?

At first glance, creating multiple streams for a single microservice (like the Auth Service) might seem like unnecessary overhead. However, in NATS JetStream, a Stream is a lightweight logical construct. The physical cost of creating a Stream is near zero. The true cost lies in **network bandwidth and CPU cycles** during consumption.

I strictly isolate `AUTH_STATE` (for JWT revocations) and `AUTH_EVENTS` (for business events like logins) into separate streams for three critical reasons:

### 1. Radically Different Retention Lifecycles

- **`AUTH_STATE` (Control Signal):** Token revocation is a highly time-sensitive, transient state. I only need to retain these signals for a short window (e.g., 15–30 minutes) in extremely fast **Memory Storage**.
- **`AUTH_EVENTS` (Historical Data):** Business events (e.g., `user.loggedIn`) are required for long-term auditing, statistics, and asynchronous tasks. These must be retained for days in **File Storage** (SSD) to guarantee persistence.

Combining them would force a compromise: either wasting expensive memory on historical data or slowing down critical security signals with disk I/O.

### 2. Preventing Fan-out Avalanches (Noise Isolation)

Ocean Chat gateways consume the `AUTH_STATE` stream using a **Fan-out Broadcast** strategy (every node receives every message) to implement Zero-I/O authentication.

If I merged business events (10,000+ logins per second) into the same stream as token revocations (10 per second), every single Gateway node would be forced to download, deserialize, and discard thousands of irrelevant login events every second. This would cause massive CPU spikes and network congestion. Isolating the streams ensures the Gateways only process the exact signals they need.

### 3. Critical Path Protection

Security commands like `auth.jwt.revoke` are **red-line critical**. If a downstream statistics service fails and causes `AUTH_EVENTS` to reach its capacity limit, I cannot allow token revocations to be dropped or delayed. Physical isolation guarantees that business data surges never impact global security enforcement.

---

## Why are `loggedIn` events published via NATS instead of direct RPC?

When a user successfully logs in, the Auth Service publishes an `auth.event.user.loggedIn` event to NATS rather than directly calling downstream services (like presence, audit, or analytics). This is a foundational **Event-Driven Architecture** decision.

### 1. Extreme Decoupling

The sole responsibility of the Auth Service is to verify identity and issue tokens. By broadcasting an event, the Auth Service does not need to know which other services care about the login.

### 2. Elimination of Synchronous Blocking

To support 10M+ concurrency, the login API must respond in under 50ms. If the Auth Service used an RPC call to notify a Push Service, network latency or a downstream outage would block the user's login. Publishing a "Fire-and-Forget" event to NATS removes all synchronous network I/O from the critical path.

### 3. Infinite Scalability

When a new business requirement arises (e.g., a "Daily Login Rewards" system), I do not need to modify the Auth Service. The new microservice simply creates a Pull Consumer on the `AUTH_EVENTS` stream.

### 4. Peak Load Smoothing (Traffic Shaping)

During traffic spikes (e.g., a push notification causing 100,000 users to open the app simultaneously), downstream services like database auditing might be overwhelmed. NATS JetStream safely buffers these events on disk. The downstream services can then Pull the events at their maximum safe consumption rate without crashing, ensuring zero data loss while preserving system stability.

---

## Why use a custom `BoundedPublisherService` instead of libraries like `p-limit`?

In high-throughput systems, the standard "Fire-and-Forget" pattern using `void js.publish()` is dangerous because it creates an unbounded number of Promises. While concurrency control libraries like `p-limit` are common, they are insufficient for protecting a 10M+ scale microservice.

### 1. The "Hidden" Unbounded Array in `p-limit`

`p-limit` effectively manages **Concurrency** (e.g., limiting active NATS requests to 100). However, it uses an **unbounded internal array** to store the backlog of tasks.

If NATS slows down or network latency spikes, but the Auth Service continues to receive 10,000 requests/sec, `p-limit` will simply push those thousands of new Promises into its internal array every second. This array consumes **V8 Heap Memory** until it inevitably triggers a Node.js process crash with an **OOM (Out of Memory)** error.

### 2. The Custom Solution: Bounded Backlog + Quota Isolation

Our `BoundedPublisherService` was manually implemented to address the memory safety issues that `p-limit` ignores:

- **Bounded Queue (Backpressure)**: Unlike `p-limit`, I enforce a `maxQueueSize` (e.g., 5000). Once reached, I proactively drop new tasks. This ensures the V8 heap remains stable regardless of NATS performance.
- **Quota Isolation**: I implemented a priority mechanism where critical security signals (revocations) have a larger quota than business events (logins). This ensures that a surge in business events cannot "choke" the system's ability to revoke tokens.
- **Zero Dependency & PnP Compatibility**: Avoided ESM/CommonJS compatibility issues with third-party libraries in our specific Yarn PnP environment.

At 10M+ scale, **deterministic memory usage** is more critical than ensuring every single non-essential event is published.

---

## Why use the Modern NATS Consumer API instead of `js.subscribe()`?

Older versions of the NATS client used `js.subscribe()` for both Push and Pull consumers. In modern NATS (v2.14+), this is deprecated in favor of a clearer, more powerful API.

### 1. Ephemeral Ordered Consumers

For Zero-I/O authentication, I use `js.consumers.get('AUTH_STATE', { filterSubjects: [...] })`. This automatically manages a high-performance **Ordered Consumer** on the client side. It is ephemeral, requires no server-side management, and automatically handles complex "Sequence Tracking" during network reconnects.

### 2. Async Iteration (`consume()`)

The new `.consume()` method returns an async iterator. This allows us to use standard `for await (...)` loops, making the consumption logic non-blocking, easy to read, and perfectly aligned with the Node.js event loop.

---

## Why enforce a strict "POJO-only" policy in Repositories?

I strictly forbid the return of Mongoose `Document` instances from our Repository layer (BaseRepository). All methods like `find`, `findOne`, `create`, and `update` must return Plain Old JavaScript Objects (POJOs).

### 1. Massive Memory/CPU Savings

A Mongoose Document is an instance of a heavy class with internal state, change tracking, and dozens of methods. Instantiating a Document for every request in a 10M+ system causes massive GC (Garbage Collection) pressure and high CPU usage. POJOs are nearly zero-overhead.

### 2. Implementation: `.lean()` and `.toObject()`

- All read operations use `.lean()` to bypass Document instantiation entirely at the driver level.
- All write operations (like `create`) immediately call `.toObject()` before returning to the Service layer.

---

## Why perform "Zero-Trust" validation on every NATS message?

Even though NATS is internal to our VPC, I treat it as an untrusted source for data integrity (Zero-Trust).

### 1. `plainToInstance` + `validateOrReject`

Every incoming message is passed through `class-transformer` and `class-validator`. This ensures that even if a developer introduces a bug in a producer, the consumer will never process malformed dates (e.g., `Invalid Date`) or missing IDs that could corrupt our MongoDB.

### 2. Precise ACK/NAK Routing

- **Validation Failed**: I immediately `m.ack()` (acknowledge) the message. This tells NATS the message is "bad debt" and should be discarded, preventing infinite redelivery loops.
- **Business/DB Failed**: I `m.nak()` (negative acknowledge) to trigger a redelivery, ensuring eventual consistency for transient infrastructure issues.

---

## The Concurrency Challenge

When a WebSocket or REST API request reaches the Ocean Chat gateway, the system must validate the user's permissions. Querying the primary database (MongoDB) or even a distributed cache (Redis) for every single message or request is impossible at our scale. A strict consistency model, where every permission change is instantaneously blocking and visible across all instances, would lead to severe lock contention and catastrophic latency.

### The Two-Tier Caching Architecture

Ocean Chat solves this by implementing a dual-layer cache within the `RoleCacheService`:

1.  **L1 Memory Cache (Local):** An LRU (Least Recently Used) cache living in the Node.js memory space of each microservice instance. It holds up to 10,000 entries with a strict 10-second Time-To-Live (TTL).
2.  **L2 Distributed Cache (Redis):** A centralized cache shared across all instances, protected by distributed locks (via `getOrSet` with jitter) to prevent cache stampedes.

The gateway always checks the L1 cache first. If a miss occurs, it checks the L2 cache. Only if both miss does the system query the underlying data source.

### The Trade-off: Eventual Consistency

By relying on an L1 memory cache with a 10-second TTL, we explicitly choose **Eventual Consistency (BASE)** over Strong Consistency (ACID).

:::warning Security Implication
If an administrator revokes a user's permissions or kicks a member from a room, the change takes up to **10 seconds** to propagate globally. During this window, the user may still be authorized to perform actions if their previous roles remain in the L1 cache of a specific gateway instance.
:::

### Why We Accept This Trade-off

- **Zero Network Overhead:** L1 cache hits resolve in sub-milliseconds without network I/O, entirely shielding Redis and MongoDB from traffic spikes.
- **OOM Protection:** The LRU mechanism prevents the Node.js process from exhausting memory.
- **Operational Simplicity:** We avoid the immense complexity of broadcasting cache invalidation events via NATS to thousands of pods. The short 10-second TTL ensures the system naturally self-corrects without manual intervention.

### Higher-Level Perspective

In distributed social and messaging applications, absolute real-time consistency for permission changes is rarely a hard business requirement. The UX impact of a 10-second delay in permission revocation is negligible compared to the massive stability and throughput gains achieved by decoupling the authorization path from database I/O. Clients gracefully handle authorization failures once the cache expires and the system rejects subsequent actions.

---
