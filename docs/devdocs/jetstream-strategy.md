---
id: jetstream-strategy
title: JetStream Topology & Consumption Strategy
sidebar_label: JetStream Architecture
description: Comprehensive guide to Ocean Chat's NATS JetStream topology, subject namespaces, and distributed consumption strategies for ten-million concurrent connections.
keywords:
  [
    ocean chat,
    nats,
    jetstream,
    message queue,
    architecture,
    high concurrency,
    pub sub,
    push pull hybrid,
  ]
---

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="JetStream Topology & Consumption Strategy | Ocean Chat" />
  <meta property="og:description" content="Comprehensive guide to Ocean Chat's NATS JetStream topology, subject namespaces, and distributed consumption strategies for ten-million concurrent connections." />
  <link rel="canonical" href="https://jameswilson19970101.github.io/ocean.chat.docs/docs/devdocs/jetstream-strategy" />
</head>

# NATS JetStream Topology & Strategy

To support ten-million concurrent connections, Ocean Chat utilizes **NATS JetStream** not just as a message broker, but as the central nervous system connecting all microservices. The topology strictly isolates high-throughput data streams from control streams and leverages wildcard routing for precise microservice consumption strategies.

## Overview Diagram

The following diagram illustrates the production and consumption flows between Ocean Chat microservices and NATS JetStream subjects.

```mermaid
---
config:
  layout: elk
---
flowchart LR
    classDef gateway fill:#f3e8ff,stroke:#9333ea,stroke-width:2px,color:#000;
    classDef service fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#000;
    classDef stream fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#000;
    classDef subject fill:#fef08a,stroke:#ca8a04,stroke-width:1px,color:#000;

    %% Producers
    subgraph Producers [Message Producers]
        WSG_P[WebSocket Gateway]:::gateway
        RS_P[Router Service]:::service
        MS_P[Message Service]:::service
        ORCH_P[Orchestrator Service]:::service
        AS_P[Auth Service]:::service
        API_P[API Gateway]:::gateway
    end

    %% JetStream Topology
    subgraph JetStream [NATS JetStream]
        subgraph S_CORE [Stream: IM_CORE]
            UP(im.up.>):::subject
            ROUTE(im.route.>):::subject
            ORCH(im.orchestrate.>):::subject
            DOWN(im.down.node.*):::subject
        end

        subgraph S_HYBRID [Stream: GROUP_HYBRID]
            TICK(group.tick.*):::subject
        end

        subgraph S_PUSH [Stream: OFFLINE_PUSH]
            PUSH(push.offline.>):::subject
        end

        subgraph S_AUTH [Stream: AUTH_STATE]
            REVOKE(auth.jwt.revoke):::subject
        end

        subgraph S_PIPE [Stream: DATA_PIPELINE]
            INDEX(pipeline.index.msg):::subject
        end

        subgraph S_TASK [Stream: BACKGROUND_TASKS]
            TASK(task.*):::subject
        end

        subgraph S_SYNC [Stream: DEVICE_SYNC]
            SYNC(sync.cursor.read.*):::subject
        end
    end

    %% Consumers
    subgraph Consumers [Message Consumers]
        RS_C[Router Service]:::service
        MS_C[Message Service]:::service
        ORCH_C[Orchestrator Service]:::service
        REAL_C[Realtime Pusher]:::service
        WSG_C[WebSocket Gateway]:::gateway
        PUSH_C[Push Service]:::service
        DP_C[Data Pipeline Worker]:::service
        MEDIA_C[Media / Audit Service]:::service
    end

    %% Production Flows
    WSG_P -- Micro-batch --> UP
    RS_P -- Business Route --> ROUTE
    MS_P -- Processed --> ORCH
    ORCH_P -- Targeted Push --> DOWN
    RS_P -- Tick --> TICK
    RS_P -- Offline Event --> PUSH
    AS_P -- Revoke --> REVOKE
    MS_P -- Persisted --> INDEX
    API_P -- Upload Event --> TASK
    API_P -- Read Receipt --> SYNC
    WSG_P -- WS Receipt --> SYNC

    %% Consumption Flows
    UP -- Pull Queue Group --> RS_C
    ROUTE -- Pull Queue Group --> MS_C
    ORCH -- Pull Queue Group --> ORCH_C
    DOWN -- Ephemeral Push --> WSG_C
    REVOKE -- Fan-out Broadcast --> WSG_C
    REVOKE -- Fan-out Broadcast --> API_P
    TICK -- Signal Push --> WSG_C
    PUSH -- Pull Consumer --> PUSH_C
    INDEX -- Large Batch Pull --> DP_C
    TASK -- Pull Explicit NAK --> MEDIA_C
    SYNC -- Ephemeral Push --> WSG_C
```

This document details the exact Stream definitions, Subject namespaces, and the delivery semantics (Push/Pull, At-Least-Once, At-Most-Once) required for the Ocean Chat architecture.

## 1. Stream Definitions (Macro Isolation)

Streams in Ocean Chat are partitioned by **business domain** and **data retention lifecycle**, never by user or group ID (which would cause stream explosion).

### **IM_CORE (Core Messaging Stream)**

- **Responsibility**: Carries all upbound user messages, inter-service routing, and downbound system pushes. This is the highest throughput stream.
- **Retention**: Limits (e.g., 3-7 days), backed up via asynchronous MongoDB persistence by dedicated Workers in the MessagePersistence data pipeline.
- **Storage**: File (SSD) for high throughput and persistence.
- **Producer**: WebSocket Gateway (upbound messages), Router & Message Logic Services (internal handoff), Orchestrator Service (downbound commands).
- **Consumer**: Router & Business Services (Pull Queue), WebSocket Gateways (downbound Push).
- **Write Fence Requirement**: All upbound messages entering this stream are subject to a write fence constraint. NATS JetStream acts as a Write-Ahead Log (WAL) to guarantee high reliability and eventual consistency. Once a message lands in the queue, an ACK is immediately returned to the client, while database persistence occurs entirely asynchronously. See the [Monkey Protocol Write Fence](./monkey-protocol-spec.md) for details.

### **AUTH_STATE (Global Security Stream)**

- **Responsibility**: Distributes JWT revocation blacklists and critical security policies to support Zero-I/O local authentication.
- **Retention**: WorkQueue or NATS KV Store.
- **Storage**: Memory or File.
- **Producer**: Auth Service.
- **Consumer**: All WebSocket Gateway and API Gateway instances.
- **Strategy**: Fan-out Broadcast (No Queue Group).

### **SYS_PRESENCE (Presence & Events Stream)**

- **Responsibility**: Handles user online/offline events and connection heartbeats.
- **Retention**: Interest (retained only while services are actively listening) or short Limits.
- **Storage**: Memory (transient data).
- **Producer**: WebSocket Gateway.
- **Consumer**: Presence Service / Push Service.
- **Strategy**: Pull Consumer with Queue Group (At-Least-Once).

### **GROUP_HYBRID (Large Group Degradation Stream)**

- **Responsibility**: Dedicated to the **Push-Pull Hybrid** strategy for mega-groups (10k+ users) to prevent fan-out avalanches.
- **Producer**: Router Service.
- **Consumer**: WebSocket Gateways (and transitively, the Clients).
- **Strategy**: Signal Push + Client Pull (Jittered HTTP/RPC).

## 2. Subject Namespace Design

The Subject hierarchy utilizes NATS wildcards (`*` and `>`) to enable precise routing.

- **Upbound Messages (Gateway -> Backend)**
  - P2P Chat: `im.up.p2p`
  - Group Chat: `im.up.group`
  - Signals (Read, Recall): `im.up.signal.*`
- **Internal Handoff (Inter-microservice Routing)**
  - Business Routing: `im.route.{service}` (e.g., `im.route.message`, `im.route.group`)
  - Push Orchestration: `im.orchestrate.{push_type}`
- **Downbound Push (Push Service -> Gateway)**
  - Targeted Node Push: `im.down.node.{gateway_node_uuid}`
- **System State**
  - Connection Events: `presence.conn.online`, `presence.conn.offline`
- **Authorization Control**
  - Token Revocation: `auth.jwt.revoke`

## 3. Microservice Consumption Strategies

Different microservices within the Ocean Chat ecosystem demand distinct consistency models and JetStream consumer types.

:::danger
Never use Push Consumers for CPU-intensive tasks (like Router or Message persistence). Under high load, Push Consumers will lead to memory exhaustion (OOM) and massive redelivery avalanches. Always use **Pull Consumers** with batching for heavy processing.
:::

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
<TabItem value="router" label="Router Service: Core Routing" default>

The Router is the brain of the IM system. It decodes Protobuf payloads and computes the target gateway nodes or downstream microservices for subsequent processing.

- **Producer**: WebSocket Gateway (publishing micro-batched client messages).
- **Consumer**: Router Service.
- **Strategy**: **At-Least-Once + Queue Group + Pull Mode**.
- **Mechanism**: Multiple Router instances share the load using a Queue Group. They use a continuous long-polling loop (e.g., fetching 500 messages at a time) to process batches. An explicit ACK is sent only after successful processing and triggering of downstream service calls.

</TabItem>
<TabItem value="gateway" label="WebSocket Gateway: Targeted Delivery">

The Connection Gateway is strictly stateless and acts as a transparent proxy.

- **Producer**: Orchestrator Service / Router Service (computing and routing to a specific gateway).
- **Consumer**: WebSocket Gateway (listening to its specific `local_uuid`).
- **Strategy**: **At-Most-Once + Ephemeral Push Consumer**.
- **Mechanism**: The backend services send downbound messages to a specific gateway node. The gateway blindly forwards it to the established WebSocket. If the gateway crashes, the message is lost in transit. Reliability is guaranteed by the client via the [Reliability & Ordering](./monkey-protocol-spec.md).

</TabItem>
<TabItem value="auth" label="Authentication Service: Zero-I/O Verification">

Implements the Zero-I/O authentication mechanism by keeping local memory states synchronized across all entry points.

- **Producer**: Auth Service (triggering token revocation).
- **Consumer**: ALL WebSocket Gateway and API Gateway instances.
- **Strategy**: **Fan-out Broadcast (No Queue Group)**.
- **Mechanism**: Every single Gateway instance (both WS and API) MUST subscribe independently to `auth.jwt.revoke`. When a token is revoked, the event reaches all gateways simultaneously so they can update their in-memory blacklists, entirely eliminating synchronous network I/O (like Redis queries) during both WebSocket handshakes and REST API requests.

</TabItem>
<TabItem value="group" label="Group Service: Push-Pull Hybrid">

Designed for mega-groups (e.g., live streaming rooms) to prevent NATS avalanches.

- **Producer**: Router Service.
- **Consumer**: WebSocket Gateways (and transitively, the Clients).
- **Strategy**: **Signal Push + Client Pull**.
- **Mechanism**: Instead of fanning out 100,000 full Protobuf messages to `im.down.node.*`, the Router publishes a tiny Tick signal containing the latest MaxSeqId to `group.tick.{group_id}`. Gateways forward the tick. Clients then initiate jittered HTTP/RPC pulls to fetch the actual payload, smoothing out backend read spikes.

</TabItem>
</Tabs>

## 4. TODO: Edge Service Streams

To protect the `IM_CORE` throughput, peripheral tasks are segregated into their own streams:

### **OFFLINE_PUSH (Third-party Push Stream)**

- **Responsibility**: Handles offline push notifications to APNs, FCM, and other vendor APIs.
- **Retention**: WorkQueue combined with `MaxMsgsPerSubject=1` and `Discard=Old` to automatically deduplicate and collapse offline notifications.
- **Storage**: File (SSD) to prevent loss during vendor API outages.

#### Stream Configuration Reference

- `retention: "workqueue"`: WorkQueue mode. As soon as the consumer successfully processes and sends an ACK, the message is immediately removed from the stream.
- `max_msgs_per_subject: 1`: Combined with wildcard subjects, ensures that the queue only retains at most the latest push task for each offline user.
- `discard: "old"`: When a second notification for the same user arrives and hits the limit, it automatically discards the old notification and replaces it with the newly arrived task.
- `storage: "file"`: Uses disk file storage to prevent memory exhaustion when a massive backlog of tasks builds up due to third-party vendor outages, while also ensuring offline tasks are not lost if the server restarts.

#### Subjects & Pub/Sub Strategy

- **`push.offline.apns.{user_id}`** / **`push.offline.fcm.{user_id}`** (Targeted Push Subjects)
  - **Producer**: Orchestrator Service (`oceanchat-orchestrator`). Triggered when it detects the target user has no active TCP connections, publishing a wake-up task to the specific subject based on the user's device type (Apple/Android).
- **`push.offline.>`** (Wildcard Consumption Subject)
  - **Consumer**: Offline Pusher Worker (`oceanchat-pusher-offline`).
  - **Strategy**: **Pull Consumer**. Since vendor APIs (Apple/Google) are prone to rate-limiting and latency, Pull mode allows the service to control the consumption rate and avoid being overwhelmed. Built-in NATS redelivery handles flaky external network calls.
  - **Consumer Configuration Reference**:
    - `deliver_policy: "all"`: Upon startup, the consumer pulls all un-ACKed backlog messages from the queue.
    - `ack_policy: "explicit"`: Explicit acknowledgment. The microservice only sends an ACK to NATS when the vendor API explicitly returns a success response.
    - `ack_wait: "10s"`: ACK timeout wait time. If the vendor interface hangs or goes down, the microservice won't send an ACK. After 10 seconds, NATS will put the task back into the queue and hand it over to another idle instance to retry.
    - `max_deliver: 5`: Maximum delivery attempts. If it fails after 5 retries, the task will be treated as a dead letter and discarded, preventing poison tasks from retrying infinitely and jamming the queue.
    - `filter_subject: "push.offline.>"`: Consumer filter subject to ensure it accurately pulls the corresponding tasks.

### **DATA_PIPELINE (Data Heterogeneity Stream)**

- **Responsibility**: Acts as the data pipeline for syncing chat records to Elasticsearch for global search.
- **Retention**: Limits (Retains data until safely indexed).
- **Storage**: File (SSD).
- **Producer**: MessagePersistence Worker (triggered immediately after saving to MongoDB).
- **Consumer**: Data Pipeline Worker.
- **Strategy**: **Large Batch Pull**. The worker fetches thousands of messages at once and uses the Elasticsearch Bulk API for high-efficiency indexing.

### **BACKGROUND_TASKS (Media & Audit Stream)**

- **Responsibility**: Manages CPU-intensive background jobs like media transcoding, image thumbnail generation, and content auditing (NSFW filters).
- **Retention**: WorkQueue.
- **Storage**: File (SSD).
- **Producer**: API Gateway or Business Microservices (upon successful file upload).
- **Consumer**: Media Service / Audit Service.
- **Strategy**: **Pull Consumer with Explicit NAKs**. If a video transcoding job fails, the consumer sends a Negative Acknowledgment (NAK) to NATS, instantly requeuing the task to another healthy instance instead of waiting for a timeout.

### **DEVICE_SYNC (Cursor Synchronization Stream)**

- **Responsibility**: Synchronizes read cursors and clears notification badges across multiple devices for the same user.
- **Retention**: Limits or Interest.
- **Storage**: Memory (Optimized for extreme IOPS; safe to lose during a NATS restart as clients will auto-sync upon reconnection).
- **Producer**: API Gateway (HTTP Receipt) & WebSocket Gateway (WS Signal Receipt).
- **Consumer**: WebSocket Gateways.
- **Strategy**: **Ephemeral At-Most-Once Push**. Gateways listen to cursor updates and silently pass them to connected clients to clear UI badges.

## 5. Reliability Sequence

The following diagram illustrates the interaction between microservices and JetStream to ensure the **Write Fence** guarantee.

```mermaid
sequenceDiagram
    participant C as Client
    participant G as Gateway
    participant R as Router
    participant N as NATS JetStream (WAL)
    participant W as MessagePersistence Worker
    participant DB as MongoDB

    C->>G: Send Message
    G->>R: Forward Payload
    R->>N: 1. Publish to IM_CORE Queue (Write-Ahead Log)

    note right of R: Write Fence
    N-->>R: NATS Publish ACK

    note left of R: Message safely lands in high-reliability queue
    R-->>G: Transaction Success
    G-->>C: ACK with SeqId

    note over W, DB: Asynchronous Persistence (Write-after-persistence)
    W->>N: Pull bulk messages
    W->>DB: 2. Bulk Insert into MongoDB
```
