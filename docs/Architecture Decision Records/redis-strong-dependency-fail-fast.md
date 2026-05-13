---
id: redis-strong-dependency-fail-fast
title: Redis Strong Dependency & Fail-Fast Strategy
description: Architecture Decision Record for treating Redis as a strong dependency with a fail-fast strategy instead of complex memory/MongoDB degradation.
keywords:
  [
    ocean chat,
    adr,
    decision-record,
    redis,
    fail-fast,
    degradation,
    infrastructure,
  ]
tags: [ocean-chat, adr, decision-record]
---

# Redis Strong Dependency & Fail-Fast Strategy

## Context

In the architecture of Ocean Chat, Redis serves as a heavily relied upon infrastructure layer. It handles critical operations including caching, routing distribution, and online presence tracking.

A previous consideration involved implementing a complex fallback mechanism using local memory and MongoDB if Redis became unavailable. This degradation strategy aimed to keep some application services running, such as the ID generator issuing a `SyncSeqId`.

## Decision

Treat Redis as a **strong dependency** and abandon the complex local memory plus MongoDB degradation plan.

Adopt a **Fail-Fast + Elastic Retry** strategy:

1. **Network Fluctuations / Single Node Failure:** Configure automatic retries and cluster node drift support directly within the Redis client library (`ioredis`) layer.
2. **Exhausted Retries / Complete Downtime:** If continuous retries fail three consecutive times, immediately throw a `ServiceUnavailableException` (resulting in an HTTP 503 or RPC exception). The gateway will catch this exception and prompt the user with: _"Network is busy, please try again,"_ effectively protecting the underlying MongoDB from avalanche impacts.

## Alternatives Considered

### Local Memory + MongoDB Degradation

- **Pros:** Might allow certain isolated operations (like ID generation) to temporarily survive a Redis outage.
- **Cons:** Introduces immense code complexity, masks underlying infrastructure failures, and cannot prevent the eventual failure of core chat features since the full messaging link inherently requires Redis.
- **Rejected:** The architectural cost outweighs the limited benefits, leading to unpredictable system states during partial outages.

## Consequences

- **Bucket Effect & Full-Link Paralysis Addressed:** Many core business flows strictly depend on Redis. Even if the ID generator successfully degrades to MongoDB, it is futile. Services like `oceanchat-presence` (online status), routing distribution, and offline push folding all rely on Redis caching. If Redis is down, messages cannot be delivered. Redis exists to ensure high performance; if the Redis cluster fails, the entire application should be considered paralyzed.

- **Exposing P0 Level Severe Faults:** A comprehensive downtime of the Redis cluster (Sentinel or Cluster mode) is an absolute P0 level disaster. Infrastructure issues must be handled by the infrastructure layer itself (e.g., automatic primary-replica switching, scaling). If silent degradation is implemented in the code, it masks the fault, preventing operations and maintenance monitoring from immediately sounding the highest-level alarm.

- **Protection of Persistent Storage:** By failing fast and returning a 503 error, we prevent an avalanche of requests from hitting MongoDB, which is not designed to handle the high throughput normally absorbed by Redis.
