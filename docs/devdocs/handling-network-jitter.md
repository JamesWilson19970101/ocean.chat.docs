---
id: handling-network-jitter
title: How to Handle Network Jitter in the Push-Pull Model
sidebar_position: auto
description: A guide on handling network jitter and ensuring message reliability when coordinating long (WebSocket) and short (HTTP) connections in Ocean Chat.
keywords: [ocean chat, network jitter, push-pull, reliability, websocket, http sync]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# How to Handle Network Jitter in the Push-Pull Model

In Ocean Chat's architecture, the **Push-Pull Hybrid Model** separates the control plane (WebSocket) and data plane (HTTP). While this maximizes scalability, coordinating long and short connections introduces vulnerability to network jitter.

This guide explains how to design your client SDK to handle network instability, ensuring zero message loss when WebSocket notifications and HTTP pulls fall out of sync.

:::tip Problem-Oriented
This is a **How-to Guide**. It assumes you are implementing the client-side synchronization logic and need to handle edge cases caused by weak networks (e.g., elevators, subways).
:::

## Scenario 1: The WebSocket `MSG_NOTIFY` is Lost

If the network drops momentarily, the server might send a `[0x08] MSG_NOTIFY` frame that the client never receives.

### Solution: Reconnection Sync (Hole Patching)

You must never rely solely on the real-time notification to trigger a sync. The `SyncSeqId` is your absolute source of truth.

1. **Detect Disconnection:** The client's asymmetric heartbeat (35-second timer) detects the dead link and triggers a reconnection.
2. **Implicit Sync on Connect:** Upon successfully re-establishing the WebSocket and completing `AUTH_REQ`, the client **must immediately** initiate an HTTP Sync request, regardless of whether a new `MSG_NOTIFY` was received.
3. **Fetch Missing Data:** Send your `MaxLocalSyncSeqId` to the `oceanchat-query` service: `GET /api/v1/messages/sync?seqId={MaxLocalSyncSeqId}`.
4. **Result:** Any messages that generated a lost `MSG_NOTIFY` during the disconnection window are safely fetched.

## Scenario 2: The HTTP Sync Request Fails

The client receives the `MSG_NOTIFY` successfully via WebSocket, but the subsequent HTTP GET request fails due to DNS issues, timeouts, or sudden signal loss.

### Solution: Pending Sync Queue and Exponential Backoff

The client must not discard the notification if the HTTP pull fails.

1. **Debounce and Queue:** When a `MSG_NOTIFY` arrives, extract the `SyncSeqId`. If it is greater than `MaxLocalSyncSeqId`, place it in a local "Pending Sync" variable.
2. **Execute HTTP Sync:** Attempt the HTTP request.
3. **Handle Failure:** If the HTTP request fails, retain the target `SyncSeqId`. Trigger a retry using **Exponential Backoff** (e.g., 1s, 2s, 4s, 8s).
4. **Merge Notifications:** If a new `MSG_NOTIFY` arrives while the client is waiting to retry, simply update the "Pending Sync" variable to the highest received `SyncSeqId`. The next HTTP pull will fetch all missing messages up to the new maximum.

## Scenario 3: Out-of-Order or Overlapping Pulls

In a weak network, a client might receive a delayed `MSG_NOTIFY`, or a user might manually refresh the app while a background HTTP Sync is already in progress, leading to race conditions.

### Solution: Client-Side Deduplication and Lock

1. **Request Lock:** The SDK must maintain an `isSyncing` boolean lock. If a sync is in progress, ignore new `MSG_NOTIFY` triggers until the current HTTP request completes.
2. **Idempotent Storage:** Due to NATS "At-Least-Once" delivery or overlapping HTTP pulls, the server might return the same message twice.
3. **Deduplicate via `ClientMsgId`:** Before inserting the fetched messages into the local SQLite/IndexedDB database, the client **must** check for the existence of the `ClientMsgId`.

```javascript title="Client Deduplication Logic"
for (const msg of httpResponse.messages) {
  const exists = await localDB.messages.findOne({ clientMsgId: msg.clientMsgId });
  if (!exists) {
    await localDB.messages.insert(msg);
  }
}
// ONLY update the cursor after successful insertion
await localDB.cursors.update({ seqId: maxReceivedSeqId });
```

## Scenario 4: The Optimistic UI Stuck in "Sending"

A user sends a message (`MSG_UP`), the WebSocket drops before the `MSG_UP_ACK` returns, but the message was successfully saved on the server.

### Solution: State Turnaround via HTTP Sync

1. The optimistic UI shows a "Sending" spinner.
2. The network recovers, and the client reconnects.
3. As per Scenario 1, the client performs an implicit HTTP Sync.
4. The HTTP response includes the message the user just sent.
5. **State Correction:** The SDK matches the incoming message's `ClientMsgId` with the local message stuck in the `SENDING` state. It updates the local row with the official `SyncSeqId` and changes the status to `SENT`, instantly stopping the UI spinner.

## Expected Result

By treating the WebSocket strictly as a lossy notification channel and relying on the `SyncSeqId` cursor for idempotent HTTP data pulls, your client SDK will gracefully survive severe network jitter. This architecture guarantees zero message loss and prevents infinite spinner states on the UI.
