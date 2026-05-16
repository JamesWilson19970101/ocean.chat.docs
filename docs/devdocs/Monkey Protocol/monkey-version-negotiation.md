---
id: monkey-version-negotiation
title: Smooth "Version Negotiation" Mechanism in the Handshake Phase
description: Detailed specification of how Monkey Protocol implements smooth degradation and forced upgrades for clients through version negotiation during the long-connection handshake phase.
keywords:
  [ocean chat, monkey protocol, version negotiation, websocket, fault tolerance]
sidebar_position: 3
tags: ["ocean-chat", "specification", "architecture", "websocket"]
---

# Smooth "Version Negotiation" Mechanism in the Handshake Phase

In C-end Instant Messaging (IM) applications, client (App/PC/Web) releases are often highly **fragmented**. When the server needs to iterate on the underlying Monkey Protocol (e.g., upgrading from `v1` to `v2` to add compression algorithms or modify frame structures), if the gateway adopts a "Hard Reject" strategy for mismatches, it leads to old clients falling into an infinite reconnection loop. This both damages the user experience and triggers connection storms at the gateway.

To address this, Monkey Protocol introduces a **Smooth Version Negotiation** mechanism during the connection handshake phase. This document specifies the protocol interaction flow and the state machine implementation for the client SDK.

---

## 1. Core Design Philosophy

1. **Handshake is Negotiation**: Leverage the existing `[0x01] AUTH_REQ` process to complete the protocol version handshake.
2. **Compatibility Probe**: The client proactively reports the **version range** it supports in the request.
3. **Graceful Rejection and Guidance**: If the server does not support the client's preferred version, it **does not directly disconnect the TCP connection**. Instead, it sends an `[0x0C] EXCEPTION_ACK` with a specific error code, indicating the versions the server currently supports.
4. **Silent Client Routing**: The client SDK intercepts the version mismatch exception and automatically performs "downgrade/upgrade reconnection" or triggers a "forced update UI," making it completely transparent to the upper business logic.

---

## 2. Protocol Structure Extension

To support version negotiation, we need to add version fields to the Protobuf payloads related to the handshake phase.

### 2.1 Client Uplink: `AUTH_REQ` Payload Extension

When sending `[0x01] AUTH_REQ`, in addition to the regular JWT Token and device information, the client must report the list of protocol versions supported by its underlying SDK.
_Note: The 2nd byte (`Version`) of the 12-byte Monkey Protocol Header represents the **preferred communication version for the current frame**._

```protobuf
message AuthReq {
  string token = 1;
  string device_id = 2;
  int32 device_type = 3;

  // New: List of all Monkey Protocol versions supported by the client's SDK
  // Example: [1, 2] means supporting both v1 and v2
  repeated uint32 supported_versions = 4;
}
```

### 2.2 Server Downlink: `EXCEPTION_ACK` Payload Extension

If the gateway rejects the preferred version, it sends an `[0x0C] EXCEPTION_ACK`. We define a dedicated error code `426` (Upgrade Required / Protocol Mismatch) for this and specify the server's supported versions in the Payload.

```protobuf
message ExceptionAck {
  int32 error_code = 1; // Fixed to 426 for protocol mismatch
  string message = 2;   // Error description, e.g., "Protocol version mismatch"

  // New: List of Monkey Protocol versions currently supported by the server gateway
  // Example: [2, 3] means the gateway currently supports only v2 and v3
  repeated uint32 server_supported_versions = 3;
}
```

---

## 3. Negotiation Interaction Flow (State Machine)

### Scenario A: Preferred Version Match (The Perfect Path)

1. The client SDK sets the `Version` in the Header to its optimal version (e.g., `0x02`).
2. The client sends `[0x01] AUTH_REQ` with `supported_versions = [1, 2]` in the Payload.
3. `oceanchat-ws-gateway` checks that the Header `Version` is `0x02` and that it supports this version.
4. The gateway calls `oceanchat-auth` for authentication; upon success, it sends `[0x02] AUTH_ACK`.
5. **Result**: Successful negotiation; all subsequent communication uses `v2`.

### Scenario B: Server-Triggered Smooth Downgrade

Assume a newly updated client supports `[1, 2]` and prefers `0x02`, but the gateway cluster hasn't finished its rolling update and currently only supports `[1]`.

1. The client sends Header `Version: 0x02` and Payload `supported_versions: [1, 2]`.
2. The gateway doesn't recognize `0x02`, but the 12-byte magic number `0x4D4B` is valid, so the gateway **proactively rejects** it.
3. The gateway sends `[0x0C] EXCEPTION_ACK` (error_code: 426, server_supported_versions: [1]).
4. **Client SDK Interception Logic**:
   - Receives error code 426.
   - Calculates the intersection: `Client[1, 2] ∩ Server[1] = [1]`.
   - Intersection is not empty! The client SDK automatically downgrades the Header `Version` to `0x01` at the underlying layer.
   - The client SDK **silently disconnects the current Socket and immediately initiates a reconnection** (without notifying the UI layer).
5. **Result**: Reconnection succeeds with a `v1` handshake; the user is unaware of the change.

### Scenario C: Critical Mismatch Leading to Forced Update

Assume an old client supports only `[1]`, but the server has undergone a major refactor and completely deprecated `v1`, with the gateway supporting only `[2, 3]`.

1. The client sends Header `Version: 0x01` and Payload `supported_versions: [1]`.
2. The gateway no longer supports `v1` and sends `[0x0C] EXCEPTION_ACK` (error_code: 426, server_supported_versions: [2, 3]).
3. **Client SDK Interception Logic**:
   - Receives error code 426.
   - Calculates the intersection: `Client[1] ∩ Server[2, 3] = Ø` (empty set).
   - Intersection is empty! This means the current App version absolutely cannot communicate with the server.
   - The client SDK **stops all reconnection attempts** and disconnects from the network.
   - The client SDK throws a fatal error event to the upper UI layer (e.g., `EVENT_FORCE_UPDATE_REQUIRED`).
4. **Result**: The App displays a blocking popup: "Your version is too old. Please update via the App Store."

---

## 4. Server Gateway Implementation Specification (`oceanchat-ws-gateway`)

To ensure performance at tens of millions of concurrent connections, version checks must be executed with the **highest priority (as a pre-interceptor)**:

1. **Zero I/O Interception**: If the gateway detects an unsupported `Version` byte in the Header, it **should not** initiate any RPC calls to `oceanchat-auth` for JWT authentication. The gateway can directly assemble the 426 `EXCEPTION_ACK`, send it back, and disconnect. This effectively defends against "authentication storms" from legacy clients.
2. **Version Configuration Delivery**: `server_supported_versions` should be read from environment variables or a configuration center to facilitate canary control during rolling updates.

```typescript
// Minimalist gateway interception pseudo-code
if (!SUPPORTED_VERSIONS.includes(header.version)) {
  const exceptionAck = encodeExceptionAck({
    errorCode: 426,
    message: "Protocol version mismatch",
    serverSupportedVersions: SUPPORTED_VERSIONS,
  });
  client.send(exceptionAck);
  // Delay disconnection for 100ms to ensure the client receives the exception packet
  setTimeout(() => client.terminate(), 100);
  return; // Terminate subsequent AUTH authentication and business forwarding
}
```

---

## 5. Summary

By introducing the 426 status code and bidirectional support list matching:

1. **Significantly Improved C-end Experience**: Non-compatible protocol upgrades no longer mean a cliff-like collapse for users of older versions. The server can support `[v1, v2]` concurrently for an extended period, allowing clients to traverse between old and new gateway nodes freely.
2. **Simplified Server Operations**: Operations teams no longer need to worry about legacy clients triggering DDoS-level automatic reconnection storms when underlying network components are updated.
3. **Robust Lifecycle Defense**: Combined with `EXCEPTION_ACK`, Monkey Protocol establishes a solid and flexible negotiation barrier before the actual chat data flow begins.
