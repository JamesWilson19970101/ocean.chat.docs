---
id: cursor-state-memory-storage
title: ADR - Use In-Memory Storage for CURSOR_STATE Stream
sidebar_label: In-Memory Cursor State
description: Architectural decision to use StorageType.Memory for the JetStream CURSOR_STATE stream to maximize throughput, leveraging client-side deduplication for fault tolerance.
keywords:
  [
    ocean chat,
    adr,
    nats,
    jetstream,
    memory storage,
    cursor state,
    deduplication,
  ]
tags: ["ocean-chat", "adr", "decision-record"]
---

# Architecture Decision Record: In-Memory Storage for CURSOR_STATE

## Status

**Accepted**

## Date

2026-05-08

## Context

In the Ocean Chat architecture, clients frequently send `[0x0B] READ_RECEIPT` signals after pulling messages. To protect the underlying MongoDB and Redis from an IOPS "write storm," these cursor updates (`lastReadSeqId`) are routed asynchronously to a dedicated NATS JetStream stream named `CURSOR_STATE`.

This stream is configured with `MaxMsgsPerSubject=1` to automatically collapse high-frequency updates into a single final state per user per group. The `MessagePersistence` worker then batches these deduplicated states and performs bulk writes to Redis and MongoDB.

The critical decision revolves around the storage medium for this specific NATS stream: `File` (SSD) or `Memory`.

## Decision

The `CURSOR_STATE` stream will explicitly use **`StorageType.Memory`**.

## Rationale

The primary goal of the `CURSOR_STATE` stream is to act as an ultra-fast, asynchronous write-behind cache. By choosing memory over disk storage, the system achieves maximum possible throughput and minimum latency at the NATS layer.

The inherent risk of in-memory storage is data loss in the event of a catastrophic NATS server crash. However, in this specific domain, losing the last few seconds of cursor acknowledgment data is entirely harmless due to the system's eventual consistency design:

1.  **Client-Side Deduplication:** If the server loses the latest `lastReadSeqId`, the client's next sync request will fall back to an older cursor position stored in Redis/MongoDB. The server will deliver a broader range of messages, including ones the client has already seen.
2.  **Idempotent Discard:** The client strictly relies on its local SQLite database and the unique `ClientMsgId` to perform deduplication. It will silently discard the duplicated messages without rendering them on the UI.
3.  **Self-Healing:** Upon receiving the messages (or upon the next reconnection), the client will automatically fire a new `READ_RECEIPT` with its latest local sequence ID, instantly repairing the server's cursor state to the most accurate point.

Therefore, the strict durability of disk storage is an unnecessary bottleneck. The system trades absolute intermediate state durability for extreme I/O efficiency.

## Alternatives Considered

### StorageType.File (SSD)

- **Pros:** Guarantees no data loss of cursor updates if the NATS server crashes or loses power.
- **Cons:** Imposes disk I/O constraints on a stream designed specifically to absorb millions of ephemeral state changes per second. Even with fast SSDs and `MaxMsgsPerSubject=1`, the file system overhead limits the theoretical peak throughput compared to raw RAM.
- **Rejected:** The guarantee is unnecessary because the client-side state machine already provides a robust fallback mechanism.

## Consequences

- **Extreme Throughput:** The gateway can dump read receipts into NATS at memory speed, ensuring zero backpressure on the WebSocket connections even during massive group chat activity.
- **Tolerable Edge-Case Redelivery:** In the rare event of a NATS node crash, a subset of clients might pull a few duplicate messages upon their next sync, which their local databases will seamlessly handle.
- **Cost Efficiency:** Reduces disk wear (TBW) and IOPS provisioning costs on the NATS cluster infrastructure.
