---
id: online-message-reliability
title: How to Guarantee Online Message Reliability
sidebar_position: 3
description: How to implement application-layer ACKs, idempotent deduplication, and sequence number tracking in Ocean Chat to ensure zero message loss.
keywords:
  [ocean chat, message reliability, ack, sequence number, idempotency, nats]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
---

# How to Guarantee Online Message Reliability

This guide details how to implement absolute online message reliability in Ocean Chat. Due to issues such as "fake online" states, intermediate network packet loss, and application-layer crashes, relying solely on TCP-layer reliability is far from sufficient in an Instant Messaging (IM) system.

To guarantee that a message is successfully delivered, processed, and persisted, Ocean Chat enforces a strict protocol based on idempotency, application-layer acknowledgments (ACKs), and sequence number tracking.

This guide assumes the reader is already familiar with the frame structure of the Monkey Protocol (specifically `ReqId` and `SyncSeqId`) and the NATS JetStream architecture.

## Step 1: Implement Client Idempotency

Network instability forces clients to retry sending messages. Without a deduplication mechanism, retries would result in duplicate records in the database.

When sending an upbound message, the client **must** generate a globally unique identifier (`ClientMsgId`, strictly using UUIDv7).

```json title="MSG_UP Payload Definition"
{
  "ClientMsgId": "018f8e91-6b9b-72d3-a456-426614174000",
  "Type": "TEXT",
  "Content": "Hello World"
}
```

The `oceanchat-message` service utilizes Redis's String data structure and the `SET ... NX EX` (Set if Not eXists with an Expiration) atomic command, using `UserID:ClientMsgId` as the unique key. This approach not only achieves ultra-fast O(1) performance but also relies on the TTL (e.g., 5 minutes) for automatic memory cleanup, gracefully intercepting and discarding duplicate retries before they ever reach the database.

## Step 2: Enforce a Server-Side Write Fence

A message cannot be considered successfully sent until it survives a potential server crash. However, writing synchronously to the database blocks connections and drastically reduces throughput.

Therefore, NATS JetStream should be used as a Write-Ahead Log (WAL) to implement a **Write Fence**:

1. The `oceanchat-message` service receives the payload and allocates a 64-bit `SyncSeqId`.
2. The service asynchronously writes the payload to the `im.orchestrate.msg` topic in NATS JetStream.
3. **Only when** NATS JetStream returns a persistence acknowledgment (ACK) is the write fence boundary considered crossed.

:::warning
Under no circumstances should a success response be returned to the client before receiving the JetStream ACK.
:::

## Step 3: Require Application-Layer ACKs

A TCP ACK merely confirms that the bytes have reached the operating system's network stack. An application-layer ACK confirms that the business logic has successfully processed the data.

Once the write fence is crossed, the gateway **must** return a `[0x06] MSG_UP_ACK` data frame. The 24-bit `ReqId` in the header of this ACK frame must perfectly match the `ReqId` from the original `[0x05] MSG_UP` frame.

**How is "Successful Processing" defined?**

- **Sender's Perspective:** As long as the client receives the `MSG_UP_ACK`, the message is considered absolutely successfully sent.
- **Server's Perspective:** To support 100,000+ concurrency, the server **will not** synchronously write the message to the underlying database (like MongoDB) before sending the ACK. "Successful processing" strictly means the message has crossed the **Write Fence** (safely stored in the NATS JetStream highly available WAL queue). Immediately after NATS confirms persistence, the server dispatches the ACK, thereby decoupling fast client responses from slow database disk writes.

## Step 4: Manage Client Timeouts and Retries

The sender needs to maintain an internal "waiting for ACK" queue.

1. Start a timer (e.g., 5 seconds) when dispatching the `MSG_UP`.
2. If `MSG_UP_ACK` is received, remove the message from the queue.
3. If the timer expires and no ACK has been received, automatically retransmit the exact same payload (including the original `ClientMsgId`) and increment a retry counter.
4. After exceeding the maximum number of retries (e.g., 3 times), mark the message as "Failed to Send" on the UI.

## Step 5: Detect and Heal Message Gaps (Holes)

For downbound delivery, to prevent large payloads from blocking the long-connection channel, the server **only pushes an ultra-lightweight wake-up notification via `[0x08] MSG_NOTIFY`** (which does not contain the message entity).

**Why is there no downbound ACK?**
Ocean Chat intentionally removed the downbound ACK for individual messages (`MSG_DOWN_ACK`) in its protocol design. In scenarios with 100k+ concurrency or massive group chats, requiring every client to reply with an ACK for every message sent would trigger a catastrophic "ACK Storm" that would crush the server. Instead, Ocean Chat guarantees zero downbound message loss by relying on a **Hole Detection** mechanism based on version numbers (`SyncSeqId`) combined with a **Push-Pull** model.

Because Ocean Chat employs a segment-based ID allocation strategy to support extreme concurrency, the `SyncSeqId` inside the payload will be monotonically increasing, but **it may be discontinuous**.

The receiving client **must** implement Hole Detection:

1. Maintain a `MaxLocalSyncSeqId` variable in local storage.
2. Upon receiving a downbound payload, compare the incoming `SyncSeqId` with the local `MaxLocalSyncSeqId`.
3. If the incoming ID is greater, it indicates a gap or jump has occurred.
4. **Never guess the missing sequence numbers.** Immediately buffer the wake-up notification and initiate a synchronization request via an **HTTP short connection** (attaching the current `MaxLocalSyncSeqId`).
5. The `oceanchat-query` service will precisely return the incremental data of the missing messages via an HTTP response.
6. Render the synchronized message stream and update the `MaxLocalSyncSeqId`.

:::info Online Notification Display Format
Currently, the plan is for **all online notifications to be implemented via in-app local notifications (such as custom banners or notification sounds within the app).** How to utilize the system's notification bar for notifications while the user is "online" will be re-planned later.
:::

## Expected Outcome

By integrating the `ClientMsgId` for deduplication, JetStream for absolute persistence, and `SyncSeqId` for gap detection, the system guarantees zero message loss and precise ordering across distributed nodes, remaining completely independent of the fluctuations of the underlying TCP/WebSocket connections.
