---
id: design-decisions-faq
title: Design Decisions & FAQ
sidebar_label: Decisions & FAQ
description: Explanations of core architectural decisions in Ocean Chat, including NATS JetStream stream isolation and event-driven authentication.
keywords:
  [
    ocean chat,
    architecture,
    nats,
    jetstream,
    event-driven,
    microservices,
    faq,
    design decisions,
  ]
---

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="Design Decisions & FAQ | Ocean Chat" />
  <meta property="og:description" content="Explanations of core architectural decisions in Ocean Chat, including NATS JetStream stream isolation and event-driven authentication." />
  <link rel="canonical" href="https://docs.oceanchat.com/docs/devdocs/design-decisions-faq" />
</head>

# Understanding JetStream Architecture Decisions

This document explains the rationale behind key architectural decisions in the Ocean Chat NATS JetStream integration, focusing on why the system is designed to support 10 million concurrent connections safely and efficiently.

## Why isolate `AUTH_STATE` and `AUTH_EVENTS` instead of using a single Stream?

At first glance, creating multiple streams for a single microservice (like the Auth Service) might seem like unnecessary overhead. However, in NATS JetStream, a Stream is a lightweight logical construct. The physical cost of creating a Stream is near zero. The true cost lies in **network bandwidth and CPU cycles** during consumption.

We strictly isolate `AUTH_STATE` (for JWT revocations) and `AUTH_EVENTS` (for business events like logins) into separate streams for three critical reasons:

### 1. Radically Different Retention Lifecycles

- **`AUTH_STATE` (Control Signal):** Token revocation is a highly time-sensitive, transient state. We only need to retain these signals for a short window (e.g., 15–30 minutes) in extremely fast **Memory Storage**.
- **`AUTH_EVENTS` (Historical Data):** Business events (e.g., `user.loggedIn`) are required for long-term auditing, statistics, and asynchronous tasks. These must be retained for days in **File Storage** (SSD) to guarantee persistence.

Combining them would force a compromise: either wasting expensive memory on historical data or slowing down critical security signals with disk I/O.

### 2. Preventing Fan-out Avalanches (Noise Isolation)

Ocean Chat gateways consume the `AUTH_STATE` stream using a **Fan-out Broadcast** strategy (every node receives every message) to implement Zero-I/O authentication.

If we merged business events (10,000+ logins per second) into the same stream as token revocations (10 per second), every single Gateway node would be forced to download, deserialize, and discard thousands of irrelevant login events every second. This would cause massive CPU spikes and network congestion. Isolating the streams ensures the Gateways only process the exact signals they need.

### 3. Critical Path Protection

Security commands like `auth.jwt.revoke` are **red-line critical**. If a downstream statistics service fails and causes `AUTH_EVENTS` to reach its capacity limit, we cannot allow token revocations to be dropped or delayed. Physical isolation guarantees that business data surges never impact global security enforcement.

---

## Why are `loggedIn` events published via NATS instead of direct RPC?

When a user successfully logs in, the Auth Service publishes an `auth.event.user.loggedIn` event to NATS rather than directly calling downstream services (like presence, audit, or analytics). This is a foundational **Event-Driven Architecture** decision.

### 1. Extreme Decoupling

The sole responsibility of the Auth Service is to verify identity and issue tokens. By broadcasting an event, the Auth Service does not need to know which other services care about the login.

### 2. Elimination of Synchronous Blocking

To support 10M+ concurrency, the login API must respond in under 50ms. If the Auth Service used an RPC call to notify a Push Service, network latency or a downstream outage would block the user's login. Publishing a "Fire-and-Forget" event to NATS removes all synchronous network I/O from the critical path.

### 3. Infinite Scalability

When a new business requirement arises (e.g., a "Daily Login Rewards" system), we do not need to modify the Auth Service. The new microservice simply creates a Pull Consumer on the `AUTH_EVENTS` stream.

### 4. Peak Load Smoothing (Traffic Shaping)

During traffic spikes (e.g., a push notification causing 100,000 users to open the app simultaneously), downstream services like database auditing might be overwhelmed. NATS JetStream safely buffers these events on disk. The downstream services can then Pull the events at their maximum safe consumption rate without crashing, ensuring zero data loss while preserving system stability.
