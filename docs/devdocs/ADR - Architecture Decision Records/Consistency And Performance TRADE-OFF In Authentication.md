# Consistency vs. Performance Trade-off in Authentication

## Background & Problem

### Login Flow

1. **Client** submits credentials (username/password).
2. **Auth Service** verifies credentials and generates a JWT.
3. **Consistency Assurance Steps**:
    - **Step A (Sync)**: Write the JWT to the Redis whitelist (set TTL). If this fails, throw an error immediately.
    - **Step B (Sync)**: Publish the `auth.event.user.loggedIn` event to NATS JetStream and wait for an Acknowledgement (Ack).
    - **Exception Handling**: If the Redis write succeeds but the NATS publish fails, immediately delete the Token from Redis (**Rollback**) and return an error to the client.
4. Return the JWT to the client.

When the `oceanchat-auth` service processes user logins, it involves write operations to two heterogeneous systems:
1. **Redis**: Writes to the JWT whitelist (Synchronous, used for Gateway authentication).
2. **NATS JetStream**: Publishes the `user.loggedIn` event (Asynchronous logic, used for downstream status/database updates).

**Core Conflict**: Redis and NATS cannot share an atomic transaction. If the Redis write succeeds but the NATS publish fails, it leads to the existence of a "Zombie Token," resulting in system inconsistency.

## Decision

We have decided to adopt the lightweight strategy of **"Failure Rollback + TTL"**, **abandoning** the heavyweight Local Message Table (Transactional Outbox) pattern.

## Final Solution Logic

1. Generate JWT.
2. Write to Redis (Default TTL = 7 days).
3. Synchronously publish the NATS message and wait for Ack.
4. If NATS fails -> Catch Exception -> **Immediately delete the Redis Key** -> Return login failure to the frontend.
5. If the Rollback (deletion) also fails -> Accept the risk (rely on Redis TTL for automatic expiration as a safety net).

## Trade-off Analysis

### Why not use the "Local Message Table (Outbox Pattern)"?

Although the MongoDB Transaction + Outbox pattern guarantees 100% eventual consistency, it has the following drawbacks:
- **Performance Overhead**: Login is a high-frequency and latency-sensitive operation. Introducing database transactions increases latency.
- **Architectural Complexity**: It requires maintaining additional Worker processes and compensation logic.
- **Low ROI (Return on Investment)**: Unlike financial transactions which require absolute rigor, login failures allow users to retry manually.

### Why is the current solution acceptable?

Even in extreme cases (Redis write succeeds -> NATS fails -> Service crashes preventing rollback):
- **Consequence**: An invalid Token remains in Redis, which will automatically disappear after 7 days.
- **Impact**: The user experiences a login failure, but the system recovers to a normal state upon a simple retry. Business data remains uncorrupted, and the security risk is negligible.