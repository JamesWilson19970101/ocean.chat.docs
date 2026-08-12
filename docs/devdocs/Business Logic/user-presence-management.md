---
id: user-presence-management
title: User Presence Management and Global Status Graph
description: 'Guide: Deep dive into how Ocean Chat senses user connection/disconnection in real-time and maintains a global presence graph supporting 100k+ concurrency.'
keywords:
  [
    ocean chat,
    presence,
    online status,
    connection management,
    heartbeat,
    websocket,
    nats jetstream,
    redis,
  ]
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# User Presence Management and Global Status Graph

This guide demonstrates how Ocean Chat accurately senses user online (connection) and offline (disconnection) status in real-time under massive concurrency, and builds a "Global Presence Graph" to support precise message routing.

By reading this guide, you will understand how the system uses a lightweight event-driven model to decouple stateful gateways from stateless business logic, elegantly handling network status changes and multi-device roaming at 100k+ or even million-level concurrency.

`oceanchat-presence` is a pure NATS microservice focused on processing user status updates, offline cleanup, and routing information maintenance. It ensures status events are never lost by listening to the `SYS_PRESENCE` stream in NATS JetStream (consumed by the persistent `presence-state-updater`). Redis serves as the single Source of Truth for status data, utilizing Hash structures to maintain the mapping of multi-device connections to their respective Gateway nodes.

## Required Core Components

To achieve real-time status graph updates, the following gateways, microservices, and stream channels must collaborate:

<Tabs>
  <TabItem value="services" label="Required Microservices" default>
    1. Connection Gateway (oceanchat-ws-gateway): The only "stateful" edge node. It holds real TCP/WS handles and emits transient online/offline events when connections are established, abnormally disconnected, or timed out.
    2. Presence Service (oceanchat-presence): A stateless business logic unit. Responsible for pulling online/offline events and transforming them into global graph data in Redis.
  </TabItem>
  <TabItem value="streams" label="Required JetStream Streams">
    1.  SYS_PRESENCE Stream:
        - Subjects: `presence.conn.online`, `presence.conn.offline`, `presence.conn.heartbeat`
        - Purpose: Buffers high-concurrency connection status change events, protecting Redis from connection storms (e.g., massive disconnects/reconnects during server restarts).
  </TabItem>
  <TabItem value="storage" label="Storage Support">
    1.  Redis Cache:
        - Purpose: Stores the "Global Presence Graph". Uses a Hash structure where the key is `user:routing:{userId}`, the field is `deviceId`, and the value is serialized JSON containing device and gateway routing information.
  </TabItem>
</Tabs>

---

## 1. Establishing Connection and Online Events (Online)

When a user opens the App or reconnects after a disconnection, the client performs a low-level TCP handshake and WebSocket upgrade with `oceanchat-ws-gateway`, completing authentication based on `[0x01] AUTH_REQ`.

1. **Local State Registration**: Once authenticated, the gateway binds the physical connection with metadata such as `userId`, `deviceId`, and `gatewayId` in its memory.
2. **Asynchronous Event Emission**: The gateway **does not** directly manipulate Redis. Instead, it assembles an extremely lightweight online event payload and asynchronously publishes it to the NATS `SYS_PRESENCE` stream (subject: `presence.conn.online`).

:::tip Extreme Decoupling
Gateways are only responsible for emitting events and immediately returning to handle network I/O. This "Fire-and-Forget" design ensures that even during a "Thundering Herd" effect of a million simultaneous reconnects, the gateway threads won't block waiting for Redis writes.
:::

**Status Update Logic**: Upon receiving an online event, `oceanchat-presence` constructs the Redis routing key `user:routing:{userId}`. It uses `deviceId` as the Hash Field to write a serialized `DevicePresence` JSON (containing `deviceId`, `deviceType`, `gatewayId`, `status: 'online'`, and `connectTime`).

**TTL Strategy**: Leveraging the new `hsetWithFieldExpire` feature in Redis 7.4+, a 300-second (5-minute) expiration is set for the specific device field, achieving precise automatic cleanup for individual devices.

## 2. Intelligent Keep-Alive Mechanism (Heartbeat)

To maintain connection survival, Ocean Chat rejects rigid, fixed-interval heartbeat strategies.

The gateway maintains a local TTL countdown (e.g., 5 minutes) for each connection.

1. **Business Packets as Heartbeats**: Whenever the client sends **any** valid upbound packet (whether a simple `[0x03] PING` or a chat signal like `[0x05] MSG_UP`), the gateway immediately resets the connection's activity status.
2. **Proactive Heartbeat Pushing**: Every 3 minutes, the gateway proactively pushes heartbeats for active devices to NATS (`presence.conn.heartbeat`). This design significantly reduces the frequency of meaningless empty packets sent by mobile devices in the background.
3. **Independent Device Renewal**: Upon receiving a heartbeat event, the Presence service directly calls the Redis `HEXPIRE` command to renew the 300-second TTL for the corresponding `deviceId` field under `user:routing:{userId}`. (Golden Ratio Strategy: 180s heartbeat interval, 300s TTL—tolerates one missed heartbeat while preventing zombie connections from lingering).

## 3. Disconnection and Offline Sensing (Offline)

User offline status usually falls into two categories, both accurately sensed by the gateway:

- **Graceful/Hard Disconnection (TCP FIN/RST)**: The user kills the App process, cuts Wi-Fi, or enters an elevator, causing the underlying Socket to be severed by the OS or network middleware. An `onClose` event is triggered instantly.
- **Heartbeat Timeout**: The client enters deep sleep and fails to send heartbeats, causing the local gateway TTL to reach zero. The gateway then proactively severs the zombie connection.

Once a disconnection is sensed, the gateway immediately publishes a `presence.conn.offline` event to the `SYS_PRESENCE` stream.

**Race Condition Prevention**: To prevent an `offline` event from an old gateway node (delayed by network lag) from accidentally deleting an online status newly established on a new gateway, the service uses a Lua script (`hdelIfJsonPropertyEquals`) to implement "Compare-And-Delete". The device's routing record is only deleted if the `gatewayId` stored in Redis strictly matches the `gatewayId` in the current offline event.

## 4. Redis Storage Structure

| Attribute        | Description                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| **Key**          | `user:routing:{userId}`                                                                         |
| **Type**         | Hash                                                                                            |
| **Field**        | `{deviceId}`                                                                                    |
| **Value (JSON)** | `{"deviceId":"...","deviceType":"...","gatewayId":"...","status":"online","connectTime":"..."}` |
| **Field TTL**    | `300s` (Redis 7.4+ field-level expiration)                                                      |

## 5. Microservice Health Check

- **RPC Subject**: `presence.ping`
- **Response Mechanism**: The Presence service, based on the NestJS microservice pattern, intercepts `@MessagePattern('presence.ping')` and returns the string `'PONG'`. This can be used by orchestration systems (like K8s) to quickly verify NATS connectivity and microservice liveness.

## End-to-End Sequence Diagram

The following diagram illustrates the complete lifecycle of a user establishing a connection, maintaining heartbeats, and finally going offline, with the system updating the Global Presence Graph in real-time:

```mermaid
sequenceDiagram
    autonumber
    participant Client as Client
    participant WSG as WS Gateway
    participant NATS as NATS (SYS_PRESENCE)
    participant Presence as Presence Service
    participant Redis as Redis (Global Graph)

    note over Client, Redis: 1. Connection & Online Status
    Client->>WSG: Establish WebSocket & AUTH_REQ
    WSG->>NATS: Async Publish presence.conn.online (incl. Gateway ID)
    NATS-->>Presence: Consume online event
    Presence->>Redis: hsetWithFieldExpire user:routing:U8899 deviceId "{JSON}" 300

    note over Client, Redis: 2. Intelligent Heartbeat
    Client->>WSG: Send business packet (e.g., MSG_UP or PING)
    WSG->>WSG: Reset local connection activity
    WSG->>NATS: Periodically publish presence.conn.heartbeat
    NATS-->>Presence: Consume heartbeat event
    Presence->>Redis: HEXPIRE user:routing:U8899 deviceId 300

    note over Client, Redis: 3. Disconnection & Offline Sensing
    Client-xWSG: Enter elevator (Network lost / Socket error)
    WSG->>WSG: Trigger onClose or Heartbeat Timeout
    WSG->>NATS: Async Publish presence.conn.offline

    NATS-->>Presence: Consume offline event
    Presence->>Redis: hdelIfJsonPropertyEquals (Lua script for race prevention)

    note right of Presence: Evaluation: If Hash is empty, user is fully<br/>offline; trigger logic (e.g., offline push decision)
```
