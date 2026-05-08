---
id: offline-message-reliability
title: How to Guarantee Offline Message Reliability
description: How to guarantee zero offline message loss in Ocean Chat using the NATS JetStream WAL, paginated HTTP Sync, and client-side deduplication.
keywords:
  [
    ocean chat,
    offline messages,
    reliability,
    ack,
    deduplication,
    sync,
    nats,
    monkey protocol,
  ]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

# How to Guarantee Offline Message Reliability

This guide details how to implement absolute reliable delivery for offline messages in Ocean Chat. When users are offline, the system must safely persist messages and trigger third-party offline notifications. Upon reconnection, the system must guarantee the accurate delivery of messages without producing duplicates or causing network overload.

Ocean Chat relies on the NATS JetStream Write-Ahead Log (WAL), the `oceanchat-pusher-offline` service for third-party APNs/FCM delivery, and the strict Push-Pull synchronization model defined in the Monkey Protocol.

## Step 1: Persist Messages via JetStream WAL

When the `oceanchat-message` service processes an upbound message (`MSG_UP`), it allocates a globally monotonically increasing `SyncSeqId` and writes the message to the `im.orchestrate.msg` topic in NATS JetStream.

Ocean Chat achieves offline reliability through a **Write-after-persistence** mechanism. As soon as NATS JetStream returns a publish acknowledgment (ACK), the message is considered safely stored. The background `MessagePersistence Worker` will asynchronously pull these messages and bulk-write them to MongoDB. This architecture thoroughly decouples fast client responses from slow database disk writes.

## Step 2: Trigger Offline Push Notifications

Simultaneously, the `oceanchat-orchestrator` push orchestration service queries the `oceanchat-presence` service (backed by Redis) to evaluate the online status of the target user.

If it detects that the target user has no active TCP/WebSocket connections, the orchestrator routes a push task to the dedicated `OFFLINE_PUSH` JetStream stream.

To prevent "write-amplification" avalanches caused by large group messages and to avoid disturbing users, the system employs a **Collapse and Replace Strategy** at this stage:

1. **Queue-Level Deduplication**: Tasks are published to user-specific sub-topics (e.g., `push.offline.apns.{user_id}`). The stream is configured with `MaxMsgsPerSubject = 1`, meaning that when a massive group instantly generates a flood of messages, NATS automatically discards older tasks, retaining only the latest wake-up task per offline user in the queue.
2. **Vendor-Level Collapsing**: The `oceanchat-pusher-offline` offline push worker consumes tasks from the `push.offline.*` topics using a Pull Queue Group. When calling third-party vendor APIs (like Apple APNs or Google FCM), the service attaches collapse identifiers (e.g., `apns-collapse-id` or `collapse_key`). The operating system's notification center will silently update the latest content and unread badge count, avoiding frequent vibrations.
3. **Physical Isolation**: Because vendor APIs are highly prone to rate limits and high latency, using an independent NATS queue isolates failures, ensuring the core IM real-time traffic (`IM_CORE`) remains unaffected. This push is essentially just a "wake-up" signal; after the client starts, it still relies on `SYNC_REQ` to pull the complete historical content.

## Step 3: Implement Paginated Bulk Pull (HTTP Sync)

When an offline client is awakened (for example, the user taps an APNs notification), it **must not** expect the server to actively push hundreds of missed messages down the long connection.

Instead, the client must execute an **Active Pull** strategy to repair message gaps:

1. The client checks the `MaxLocalSyncSeqId` saved in local storage (e.g., SQLite).
2. The client sends a synchronization request containing this ID to the API Gateway via an **HTTP short connection** (e.g., `GET /api/v1/messages/sync?seqId={MaxLocalSyncSeqId}`).
3. The `oceanchat-query` data query service receives the HTTP request and fetches all messages strictly greater than that `MaxLocalSyncSeqId` from the database (MongoDB).
4. The server returns the array of missing messages to the client via the HTTP response.

:::warning Paginated Pulling
For users who have accumulated a massive backlog of offline messages, clients must implement a pagination mechanism (e.g., pulling 100 messages at a time) to prevent large payloads from triggering API timeouts or client-side out-of-memory (OOM) errors.
:::

## Step 4: Enforce Client-Side Deduplication

During the HTTP Sync between the client and server, network fluctuations or client retries might result in fetching the same missing messages multiple times (constituting "At-Least-Once" delivery semantics).

The receiving client **must** implement a deduplication mechanism:

1. When parsing the HTTP response payload, extract the `ClientMsgId` from each message.
2. Query the local device database. If a message with the identical `ClientMsgId` already exists, silently discard the duplicate.
3. Only update the local `MaxLocalSyncSeqId` cursor after the entire batch of messages has been successfully persisted locally.

## Expected Outcome

By integrating the NATS JetStream WAL for absolute server-side persistence, physically isolating third-party APNs/FCM calls into the `OFFLINE_PUSH` stream, and relying on HTTP Sync with local deduplication logic upon reconnection, you can guarantee that offline users accurately receive every missed message without compromising the real-time throughput performance of the long-connection gateway.
