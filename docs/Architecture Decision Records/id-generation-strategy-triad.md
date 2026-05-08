---
id: id-generation-strategy-triad
title: ADR - Three-Tiered Distributed ID Generation Strategy
sidebar_label: Three-Tiered ID Strategy
description: Architectural decision to implement a decoupled, three-tiered ID generation strategy utilizing UUID v7, Client UUIDs, and a hybrid of Custom Segments and Sonyflake for Ocean Chat.
keywords: [ocean chat, adr, id generation, uuid v7, sonyflake, syncseqid, segment allocation]
tags: ["ocean-chat", "adr", "decision-record"]
sidebar_position: auto
---

# Architecture Decision Record: Three-Tiered Distributed ID Generation Strategy

## Status

**Accepted**

## Date

2026-05-08

## Context

Generating IDs in a massive-scale distributed IM system presents conflicting requirements. We need IDs for entities (users, groups) that are decentralized to prevent bottlenecks. We need IDs to prevent duplicate message sending from clients due to network retries. Crucially, we need IDs to physically store messages efficiently while simultaneously providing strict monotonic sequencing per session to allow clients to detect missing messages (gap detection). 

Attempting to solve all these problems with a single unified ID type (like a standard UUID v4 or a single global Snowflake generator like Meituan Leaf) either leads to severe database index fragmentation or introduces unnecessary centralized network bottlenecks.

## Decision

Ocean Chat will adopt a decoupled, three-tiered ID generation strategy tailored to specific operational contexts:

1. **Entity Identity (User/Room) 👉 UUID v7**
   - **Context:** Account registration, group creation.
   - **Mechanism:** Generated locally by the respective microservice.
2. **Upbound Anti-Duplication (`ClientMsgId`) 👉 Client UUID v7 / UUID v4**
   - **Context:** The moment a user clicks "Send" on the mobile device.
   - **Mechanism:** Generated entirely by the client device.
3. **Downbound Sync & Storage (`SyncSeqId` & `ServerMsgId`) 👉 Custom Segment (Redis) + Server Sonyflake**
   - **Context:** Message persistence and push notification dispatch.
   - **Mechanism:** The `oceanchat-message` service allocates a session-scoped `SyncSeqId` via a custom segment-based generator backed by Redis, and simultaneously generates a global `ServerMsgId` using Sonyflake.

## Rationale & Advantages

### 1. Entity Identity (UUID v7)
- **Decentralization:** Microservices can generate entity IDs instantly without blocking on a centralized ID allocator.
- **Index Friendly:** Unlike UUID v4, UUID v7 includes a timestamp component, making it time-ordered. This drastically reduces B+ tree page splits during database inserts, yielding performance comparable to auto-incrementing integers while retaining cryptographic uniqueness.
- **Anti-Traversal:** The significant random entropy prevents malicious scraping of all user or group data by guessing sequential IDs.

### 2. Upbound Anti-Duplication (Client UUID)
- **Server Independence:** The client does not need to request an ID from the server before sending.
- **Strict Idempotency:** If the client experiences network latency and retries sending the same message multiple times, the `ClientMsgId` remains identical. The server seamlessly identifies and deduplicates the request without writing redundant records.

### 3. Downbound Sync & Storage (Segment + Sonyflake)
- **Physical Storage Optimization:** Sonyflake acts as the MongoDB `_id` (`ServerMsgId`). It generates 64-bit integers that are shorter than UUIDs, extremely fast to index, and inherently time-ordered.
- **Business Logic Optimization:** The custom Segment-based generator (backed by Redis `INCRBY`) provides the `SyncSeqId`. This guarantees strict monotonic incrementation per session (e.g., Group A gets 1, 2, 3; Group B gets 1, 2, 3). This isolation enables clients to perform "brainless" mathematical gap detection to pull missing messages incrementally, without relying on complex sync tree calculations.

## Alternatives Considered

### Using Meituan Leaf for Sequence IDs
- **Pros:** A highly mature, battle-tested global ID generator.
- **Cons:** It is designed for global business tags (e.g., "order_id"). In an IM context, we need millions of dynamically created and destroyed tags (one for every P2P chat and group). Managing millions of dynamic tags in Leaf introduces massive operational complexity and an unnecessary extra network hop for every message.
- **Rejected:** A lightweight, custom Segment-based generator directly inside the message service utilizing Redis `INCRBY` is vastly more efficient for session-scoped sequential generation.

### Using UUID v4 for Everything
- **Pros:** Maximum simplicity.
- **Cons:** Fatal performance degradation during massive database inserts due to absolute randomness causing index fragmentation. It also provides zero context for message ordering.
- **Rejected:** Unacceptable for a high-concurrency data persistence layer.

## Consequences

- The ID logic is heavily decentralized across the client, general microservices, and the specific message routing layer, requiring careful documentation.
- The `oceanchat-message` service must implement and manage the Worker IDs necessary for its internal Sonyflake generation.
- The database storage remains highly optimized, and the client synchronization logic becomes mathematically infallible due to the strict `SyncSeqId` behavior.
