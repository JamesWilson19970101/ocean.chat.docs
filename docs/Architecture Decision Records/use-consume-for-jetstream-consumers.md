---
id: adr-use-consume-for-jetstream
title: ADR-005 - Standardize on consume() for NATS JetStream
description: Architecture Decision Record detailing why Ocean Chat standardizes on Pull Consumers and the consume() API for all NATS JetStream message consumption.
keywords:
  [
    ocean chat,
    adr,
    decision-record,
    nats jetstream,
    consume,
    pull consumer,
    push consumer,
  ]
image: https://docs.oceanchat.com/img/social-card.png
---

# ADR-005: Standardize on `consume()` for NATS JetStream Consumers

## Status

Accepted

## Date

2024-05-15

## Context

Ocean Chat relies heavily on NATS JetStream for asynchronous message delivery, event sourcing, and maintaining the Write-Ahead Log (WAL). To support hundreds of thousands of concurrent connections, the microservices must consume messages from NATS efficiently without being overwhelmed during traffic spikes (e.g., massive group chat broadcasts or server cold starts).

NATS JetStream offers several ways to consume messages:

- **Push Consumers (`subscribe()`)**: The server pushes messages to the client as fast as possible.
- **Pull Consumers (`consume()`, `fetch()`)**: The client explicitly requests batches of messages based on its current processing capacity.
- **Ordered Consumers**: A simplified, ephemeral consumer that handles sequence tracking automatically but drops explicit acknowledgments.

A decision must be made to standardize the consumption pattern across all Ocean Chat microservices to ensure system stability, prevent Out-Of-Memory (OOM) crashes, and simplify the developer experience.

## Decision

Standardize on **Pull Consumers** using the **`consume()`** API for all persistent and high-throughput NATS JetStream message consumption within the Ocean Chat ecosystem.

In short, `consume()` is chosen as the universal default because it is simply sufficient and provides the highest degree of safety for almost all use cases.

## The `consume()` Mechanism (Push-Pull Hybrid)

Under the hood, `consume()` implements an intelligent Push-Pull hybrid mechanism (specifically, Long Polling with batch prefetching).

- **Message Fetching Process:** When `consume()` is initialized, the JetStream client does not just ask for one message. It sends a pull request to the server requesting a batch of messages (controlled by `max_messages`).
- **Server Push:** The NATS server receives this request and immediately starts "pushing" available messages to the client until the requested batch size is met.
- **Timeout Handling:** Every pull request has an expiration time (e.g., `expires` parameter). If the server has no new messages to send before the timer runs out, the pull request gracefully expires.
- **Re-fetch Timing:** The client library automatically manages this lifecycle. The moment a pull request expires (or the number of messages consumed has exceeded the threshold.), the client _immediately_ and transparently issues a new pull request in the background. This ensures the client's local buffer always has messages ready for the `for await (const msg of iter)` loop, minimizing latency.

## Capacity Proof: Sufficiency for 100k+ Concurrency

A common misconception is that pull-based consumers are too slow for high concurrency compared to pure push. However, for Ocean Chat's target of 100,000+ concurrent connections, `consume()` is mathematically and practically sufficient:

1. **Concurrency vs. Throughput:** 100,000 concurrent WebSocket connections do not generate 100,000 messages per second (TPS). In a typical IM system, only a fraction of users are sending messages at the exact same second. A 100k CC system typically sees 1,000 to 5,000 TPS.
2. **Batching Efficiency:** `consume()` does not pull messages one by one. By pre-fetching batches (e.g., 100 or 500 messages at a time), the network overhead of the pull request is amortized across hundreds of messages. NATS handles this with near-zero latency.
3. **Node.js Processing Power:** A single Node.js instance processing messages via `consume()` can easily handle 5,000+ TPS assuming standard JSON parsing and asynchronous DB writes.
4. **Horizontal Scaling:** Because `consume()` provides built-in backpressure, it is exceptionally safe to scale horizontally. If the throughput spikes to 20,000 TPS, spinning up 4-5 service instances in a Queue Group effortlessly distributes the load. They will smoothly pull messages without overwhelming any single instance.

Therefore, the supposed "overhead" of pull requests is completely negligible, while the stability guarantees (no OOMs) make it the optimal choice for a 100k+ CC architecture.

## Alternatives Considered

### Push Consumers (`subscribe()`)

- **Pros:** Conceptually simple; traditionally used in older pub/sub models. Slightly lower latency for extremely low-volume streams.
- **Cons:** Susceptible to the "slow consumer" problem. If a downstream service (like MongoDB persistence) slows down, NATS will continue pushing messages into the Node.js event loop. This leads to unbounded buffer growth, memory exhaustion, and eventual process crashes.
- **Rejected:** The lack of implicit backpressure makes it entirely unsuitable for handling the bursty, high-volume traffic characteristic of an IM system.

### Ordered Consumers

- **Pros:** Automatically handles consumer recreation if a sequence gap is detected. Extremely fast.
- **Cons:** Ordered consumers are strictly ephemeral and do not support explicit message acknowledgments (`AckNone`).
- **Rejected:** Ocean Chat requires absolute message reliability (At-Least-Once delivery). The lack of explicit ACKs means a process crash during message handling would result in permanent data loss.

### Pull Consumers with `fetch()`

- **Pros:** Pull-based, offering excellent flow control.
- **Cons:** `fetch()` is a discrete request-response mechanism (give me N messages right now). It is less efficient for continuous streaming because it requires repeatedly issuing fetch requests, adding latency between batches.
- **Rejected in favor of `consume()`:** While `fetch()` is useful for one-off tasks, `consume()` provides a continuous, async-iterable stream that automatically manages the underlying pull requests (prefetching) while maintaining strict flow control.

## Consequences

- **Built-in Backpressure:** By using `consume()`, the application natively controls the processing rate. The service will never buffer more messages in memory than it can handle, completely eliminating NATS-induced OOM crashes.
- **Horizontal Scalability:** Multiple service instances can safely bind to the same Durable Pull Consumer name to form a Queue Group, seamlessly distributing the workload.
- **Simplicity:** Standardizing on one method reduces the cognitive load. Developers know that `consume()` is the correct, safe choice for almost all use cases in the system because "it is simply sufficient and good enough" for 99% of our needs.
- **Requirement:** Developers must ensure that messages are explicitly acknowledged (`msg.ack()`) after successful processing, as `consume()` defaults to `AckExplicit`.
