---
id: group-message-flow
title: Group Message Lifecycle (Sending & Receiving)
description: Understand the complete lifecycle of a group message in Ocean Chat, from the sender to online push, offline notifications, and asynchronous persistence.
keywords:
  [
    ocean chat,
    group message,
    architecture,
    push-pull hybrid,
    nats jetstream,
    flow,
    sequence diagram,
    syncseqid,
  ]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Group Message Lifecycle: Sending & Receiving

This document explains the end-to-end lifecycle of a group message within the Ocean Chat architecture. It details how the system leverages a **Read-Diffusion (Store Once) model** combined with a **Push-Pull Hybrid strategy** to deliver messages to thousands of group members without triggering a "write storm" or network avalanche.

The process is divided into four major phases: **Ingestion & Persistence (Upbound)**, **Targeted Delivery (Downbound)**, **Message Entity Synchronization (Data Plane)**, and **Cursor State Acknowledgment (Control Plane)**.

---

## 1. The Global Architecture Strategy

Before examining the flow, it is critical to understand the foundational strategies employed by Ocean Chat for group messaging:

- **Store Once (Read-Diffusion):** A group message entity is saved only once in the global MongoDB `GroupMessages` collection. The system does _not_ create individual copies for every member.
- **Push-Pull Hybrid:** The WebSocket long connection is strictly reserved for extremely lightweight signaling (Control Plane). Actual message payloads are pulled incrementally by clients via HTTP short connections (Data Plane).
- **Asynchronous Decoupling:** NATS JetStream (Write-Ahead Log) is the absolute boundary separating fast client interactions from slow database I/O.

---

## 2. Phase 1: Ingestion & Persistence (Upbound)

When a user sends a message to a group, the goal of this phase is to rapidly accept the message, validate it, assign it a global sequence ID, and safely store it in the WAL before returning an acknowledgment to the sender.

```mermaid
sequenceDiagram
    autonumber
    participant Sender as Client A
    participant WSG as WS Gateway
    participant Router as oceanchat-router
    participant MsgService as oceanchat-message
    participant GroupService as oceanchat-group
    participant NATS as NATS JetStream
    participant Worker as MessagePersistence Worker
    participant MongoDB as MongoDB

    Sender->>WSG: [0x05] MSG_UP (GroupId, ClientMsgId)

    rect rgb(243, 232, 255)
        note right of WSG: Phase 1: Ingestion
        WSG->>NATS: Publish raw bytes to im.up.group
    end

    rect rgb(219, 234, 254)
        note right of Router: Phase 2: Routing
        NATS-->>Router: Pull from im.up.>
        Router->>Router: Decode Protobuf & Basic Validation
        Router->>NATS: Publish to im.route.group
    end

    rect rgb(220, 252, 231)
        note right of MsgService: Phase 3: Business Logic & Write Fence
        NATS-->>MsgService: Pull from im.route.group
        MsgService->>GroupService: RPC: Verify sender's permissions in the group
        GroupService-->>MsgService: Return Verification OK
        MsgService->>MsgService: Assign session-level SyncSeqId
        MsgService->>NATS: Publish to WAL (im.orchestrate.msg)
        NATS-->>MsgService: ACK (Write Fence Passed)

        note over MsgService, Sender: Write fence passed! Safe to return ACK to client.
        MsgService->>NATS: Publish message to im.down.node topic
        NATS-->>WSG: Route and deliver to the specific gateway
        WSG->>Sender: Deliver [0x06] MSG_UP_ACK (SyncSeqId)
    end

    rect rgb(254, 240, 138)
        note right of Worker: Phase 4: Async Background Persistence
        NATS-->>Worker: Batch Pull from im.orchestrate.msg
        Worker->>MongoDB: Bulk Insert to GroupMessages (Store Once)
        Worker->>NATS: Manual ACK (Remove from Queue)
    end
```

### Key Mechanisms:

- **Write Fence:** The sender receives the `MSG_UP_ACK` immediately after Step 8 (when NATS acknowledges the write). The sender _does not wait_ for the MongoDB insertion, guaranteeing sub-millisecond response times.
- **Deduplication:** The sender must provide a unique `ClientMsgId`. If the sender retries due to a network drop, the backend uses this ID to prevent duplicate `SyncSeqId` generation or duplicate database records.

---

## 3. Phase 2: Targeted Delivery (Downbound)

Once the message safely lands in the `im.orchestrate.msg` topic, the Push Orchestrator takes over. Its job is to split the massive recipient list into online and offline groups and route them appropriately.

Assume a group has **10,000 members** (2,000 online, 8,000 offline).

```mermaid
sequenceDiagram
    participant NATS as NATS JetStream
    participant Orch as oceanchat-orchestrator
    participant Presence as oceanchat-presence (Redis)
    participant PushRT as oceanchat-pusher-realtime
    participant PushOff as oceanchat-pusher-offline
    participant APNs as Apple / Google API

    NATS-->>Orch: 1. Pull Message (im.orchestrate.msg)
    Orch->>Presence: 2. MGET Online Status for 10,000 members
    Presence-->>Orch: 3. Return (2000 Online nodes, 8000 Offline)

    alt Online Members (2,000 users)
        Orch->>PushRT: 4. Dispatch tasks grouped by Gateway Node
        PushRT->>NATS: 5. Publish MSG_NOTIFY signal to im.down.node.{id}
    end

    alt Offline Members (8,000 users)
        Orch->>NATS: 6. Publish Wake-up Task to OFFLINE_PUSH Stream
        note right of NATS: Subject: push.offline.apns.{userId}<br/>MaxMsgsPerSubject=1 (Queue Collapse)
        NATS-->>PushOff: 7. Pull Deduplicated Task
        PushOff->>APNs: 8. HTTP POST (Silent Notification)
    end
```

### Key Mechanisms:

- **Zero-Payload Push:** The `MSG_NOTIFY` sent to the 2,000 online users via WebSocket contains _no message content_. It only carries the `GroupId` and the latest `SyncSeqId` (e.g., `{"seqId": 1005}`).
- **Queue Collapse (Anti-Storm):** For the 8,000 offline users, the Orchestrator publishes tasks to `push.offline.apns.{userId}`. Because this stream is configured with `MaxMsgsPerSubject=1`, if 10 messages are sent to this group in 1 second, NATS automatically drops the older 9 tasks. The `oceanchat-pusher-offline` worker will only pull the final wake-up task, calling the Apple/Google API exactly once per user, drastically saving bandwidth and preventing notification spam.

---

## 4. Phase 3: Message Entity Synchronization (Data Plane)

Both online users receiving the `MSG_NOTIFY` signal and offline users waking up from an APNs push must actively pull the actual message entities.

```mermaid
sequenceDiagram
    autonumber
    participant Receiver as Client B
    participant APIGW as API Gateway
    participant Query as oceanchat-query
    participant Redis as Redis (Singleflight Lock)
    participant MongoDB as MongoDB

    Receiver->>Receiver: Detect Gap: MaxLocalSyncSeqId (1000) < Signal (1005)
    Receiver->>APIGW: HTTP GET /messages/sync?groupId=G1&seqId=1000
    APIGW->>Query: Forward Sync Request

    note over Query, Redis: Singleflight Defense (Thundering Herd)
    Query->>Redis: Try Lock for G1+SeqId:1000

    alt Lock Acquired (First Request)
        Query->>MongoDB: Query Messages where SeqId > 1000
        MongoDB-->>Query: Return 5 Message Entities
        Query->>Redis: Cache Result for 3 seconds
    else Lock Failed (Concurrent Requests)
        Query->>Redis: Wait briefly, then read directly from Cache
    end

    Query-->>APIGW: Return Array of Message Entities
    APIGW-->>Receiver: HTTP 200 OK (Data Plane Payload)

```

### Key Mechanisms:

- **Singleflight Defense (Thundering Herd):** When 2,000 online users receive the MSG_NOTIFY simultaneously and fire HTTP GET requests within milliseconds, the oceanchat-query service uses a Singleflight pattern and a short-lived Redis cache to ensure only the first request penetrates to MongoDB. The remaining 1,999 requests return results directly from memory, perfectly protecting the database from instant collapse.
- **Client Deduplication:** When parsing the HTTP response array, the client must use the ClientMsgId of each message against its local SQLite database to silently discard any duplicate messages caused by network retries.

## 5. Phase 4: Cursor State Acknowledgment (Control Plane)

It is important to clarify that after the client pulls the message entities in the background (Data Plane), it **does not** immediately send an acknowledgment. The client only reports its latest consumption progress to the backend when the user actually opens the group chat window and **physically reads (renders on the UI)** those messages.

The core business goal of this phase is to support **accurate unread badge calculation**, **multi-device synchronization to clear badges**, and **cross-device roaming recovery** (seamlessly restoring chat history and unread status when a user switches phones, reinstalls the app, or logs in on a tablet/PC). The primary technical challenge is recording this state while defending against a "database write storm" triggered by millions of users sending read receipts simultaneously.

```mermaid
sequenceDiagram
    autonumber
    participant Receiver as Client B
    participant WSG as WS Gateway
    participant NATS as NATS (CURSOR_STATE)
    participant Worker as MessagePersistence Worker
    participant Redis as Redis Cache
    participant MongoDB as MongoDB
    note over Receiver, WSG: Async Cursor ACK (Zero-I/O)
    Receiver->>WSG: WebSocket Send [0x0B] READ_RECEIPT
    WSG->>NATS: Async Publish to cursor.read.G1.U1
    note over NATS, Worker: Queue Collapse Anti-Storm (MaxMsgsPerSubject=1)
    Worker->>NATS: Batch Pull deduplicated cursor states
    Worker->>Redis: Pipeline batch update Redis cache
    Worker->>MongoDB: BulkWrite batch update DB cursors
```

### Key Mechanisms:

Driving the "Unread Badge" and Business Loop: The persistence worker updating the cursor not only provides accurate data for calculating offline push badge counts but also integrates with the backend DEVICE_SYNC flow. This instantly notifies the user's concurrently online PC or iPad to clear the corresponding group unread badge.

- **Extreme Asynchrony and Zero Gateway I/O:** Upon receiving the READ_RECEIPT, the gateway performs no read/write operations. Instead, it instantly dumps the payload into the NATS CURSOR_STATE stream.
- **Underlying Queue Collapse:** This stream utilizes the MaxMsgsPerSubject=1 mechanism. If a user constantly scrolls the screen in a group, generating a massive amount of receipts, NATS automatically drops the old cursors and retains only the latest lastReadSeqId for that group, eliminating redundant data at the source.
- **Batch Dual-Write Persistence:** The background Worker pulls this batch of collapsed, simplified states and uses Redis Pipeline and MongoDB BulkWrite to complete the cursor updates, completely protecting database IOPS performance.

:::tip Summary
This Push-Pull architecture guarantees that the real-time WebSocket connection is exclusively used for ultra-fast, low-bandwidth control signaling. Heavy data transfer and historical synchronization are entirely offloaded to scalable HTTP endpoints, ensuring Ocean Chat can comfortably handle groups with tens of thousands of active members.
:::
