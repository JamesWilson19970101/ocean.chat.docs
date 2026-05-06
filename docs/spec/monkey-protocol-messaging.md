# Spec: Monkey Protocol Messaging Implementation

## Objective

To implement the Monkey Protocol for Ocean Chat, a high-concurrency binary WebSocket protocol capable of supporting 100k+ concurrent connections. This implementation will cover Zero-I/O authentication, a JetStream-backed Write Fence for messaging, push-pull hybrid delivery for large groups, and HTTP-based file upload/download for rich media (Control Plane + Data Plane separation).

## Tech Stack

- **Framework**: NestJS 11, TypeScript 5
- **WebSocket**: Native `ws` library (custom NestJS WS Adapter for Buffer/ArrayBuffer manipulation)
- **Protobuf**: `ts-proto` plugin via `protoc` (compiled directly to TS, strictly no `.proto` files needed in build output)
- **Message Broker**: NATS JetStream
- **Database**: MongoDB (via Mongoose)
- **Object Storage**: OSS/Local File Storage (for HTTP Data Plane)

## Commands

```bash
# Generate Protobuf TS files
yarn workspace @app/monkey-protocol proto:generate

# Build API Gateway & WS Gateway
yarn workspace @app/oceanchat-ws-gateway build
yarn workspace @app/oceanchat-api-gateway build

# Run E2E Tests (WebSocket + NATS)
yarn workspace @app/oceanchat-ws-gateway test:e2e
```

## Project Structure

- `libs/monkey-protocol/`: Contains `.proto` definitions and `ts-proto` generated TS interfaces/classes.
- `apps/oceanchat-ws-gateway/src/`: Native `ws` Adapter, binary frame parser (12-byte header + payload), Zero-I/O Auth Guard.
- `apps/oceanchat-ws-gateway/test/`: Node.js E2E test scripts using `ws` client and compiled protobufs to simulate full binary chat flows.
- `apps/oceanchat-router/`: JetStream publisher, handles routing logic and Write Fence publishing.
- `apps/oceanchat-message/`: JetStream Pull Consumer (Worker), strictly asynchronous MongoDB persistence (削峰填谷).
- `libs/models/`: `Message` Mongoose Schema supporting Text, File, and Image structures.
- `apps/oceanchat-api-gateway/`: REST API endpoints for OSS HTTP Upload/Download (Data Plane).

## Code Style

```typescript
// 12-Byte Header Parsing Example
export class MonkeyFrame {
  constructor(
    public magic: number, // 0x4D4B
    public version: number,
    public cmd: number,
    public flags: number,
    public seqId: number,
    public length: number,
    public payload: Buffer,
  ) {}

  static decode(buffer: Buffer): MonkeyFrame {
    if (buffer.length < 12) throw new Error("Frame too short");
    const magic = buffer.readUInt16BE(0);
    const version = buffer.readUInt8(2);
    const cmd = buffer.readUInt8(3);
    const flags = buffer.readUInt8(4);
    // SeqId is 3 bytes
    const seqId =
      (buffer.readUInt8(5) << 16) |
      (buffer.readUInt8(6) << 8) |
      buffer.readUInt8(7);
    const length = buffer.readUInt32BE(8);
    const payload = buffer.subarray(12, 12 + length);
    return new MonkeyFrame(magic, version, cmd, flags, seqId, length, payload);
  }
}
```

## Testing Strategy

Following the **NestJS Pragmatic Testing** guidelines:

- **Scope**: E2E "Black-Box" testing is the primary focus.
- **Environment**: Test against a live NATS JetStream instance and a live WebSocket server.
- **Tooling**: A custom Node.js test script using the native `ws` client package inside Jest.
- **Flow**:
  1. Client connects via WS.
  2. Client sends `AUTH_REQ` (0x01) with a valid JWT.
  3. Server returns `AUTH_ACK` (0x02) purely via memory signature validation.
  4. Client sends `MSG_UP` (0x05) (Protobuf Buffer).
  5. Server publishes to NATS `im.up.>` and waits for NATS ACK.
  6. Server returns `MSG_UP_ACK` (0x06).
  7. Client verifies `MSG_UP_ACK`.

## Boundaries

- **Always do**:
  - Treat the NATS JetStream ACK as the strict Write Fence. `MSG_UP_ACK` must be sent _after_ NATS ACK, but _before_ MongoDB insertion.
  - Parse frames purely via `Buffer` operations without stringifying binary data.
  - Generate `ts-proto` files completely free of `protobufjs` reflection/runtime file dependencies at runtime.
- **Ask first**:
  - Changing NATS stream definitions or retention policies.
  - Introducing new dependencies to `oceanchat-ws-gateway`.
- **Never do**:
  - Execute a MongoDB `insert` synchronously in the `MSG_UP` WS lifecycle.
  - Make a network request (HTTP/Redis) to validate a JWT in the WS connection handshake.
  - Send raw multimedia binary streams over WebSocket (always use the HTTP Data Plane).

## Success Criteria

1. `libs/monkey-protocol` successfully outputs pure TS types using `ts-proto` and requires no `.proto` assets in the `dist` folder.
2. `oceanchat-ws-gateway` implements a Zero-I/O authentication layer, dropping invalid connections locally in `O(1)` time.
3. Sending a text message returns `MSG_UP_ACK` immediately after the message hits JetStream (`IM_CORE` stream), achieving high concurrency safely.
4. `oceanchat-message` safely pulls from JetStream in the background and writes to MongoDB without blocking the gateway (削峰填谷).
5. Large group push-pull logic routes a `MSG_NOTIFY` (0x08) to gateways, and clients pull payload via HTTP/RPC.
6. The E2E tests fully cover the Binary Header + Protobuf Payload encode/decode cycle using a real `ws` connection.
7. HTTP File Upload/Download APIs are functional, and clients can correctly send a `MSG_UP` Control Plane signal containing the generated OSS URL.

## Open Questions

- None. All assumptions have been clarified.
