---
id: why-chose-livekit-over-mediasoup-and-jitsi
title: Why I Abandoned Mediasoup and Jitsi for LiveKit
description: Architecture Decision Record on selecting LiveKit to support 100k concurrent WebRTC streams in Ocean.Chat.
keywords:
  [
    ocean chat,
    adr,
    decision-record,
    webrtc,
    livekit,
    mediasoup,
    jitsi,
    architecture,
  ]
image: https://docs.oceanchat.com/img/social-card.png
tags: [ocean-chat, adr, decision-record]
---

# ADR: Why I Abandoned Mediasoup and Jitsi, Choosing LiveKit for 100k Concurrent WebRTC Streams

I will not implement this in the code for now. I will introduce LiveKit to add audio and video functionality after the message is sent.

## Status

Accepted

## Date

2026-05-10

## Context

Ocean.Chat is positioned as a customized communication platform for Small and Medium Enterprises (SMEs) and specific "Scopes" (domains).

Currently, my technology stack is built on TypeScript and NestJS microservices, utilizing NATS JetStream as the message bus.

:::info Architectural Constraint
The core business logic operates behind a completely **stateless** WebSocket gateway. Any new infrastructure must strictly preserve this statelessness and high ROI.
:::

The challenge at hand is introducing high-quality, multi-user audio and video conferencing capabilities to the platform. The architecture must be scalable enough to support a vision of **100,000 concurrent streams**, which translates to approximately 100Gbps of peak bandwidth.

## Decision

Integrate **LiveKit** as the core WebRTC SFU (Selective Forwarding Unit) infrastructure, discarding initial prototypes and evaluations of Jitsi and Mediasoup.

## Alternatives Considered

### The First Tier Eliminated: Jitsi

Jitsi is a complete, off-the-shelf product rather than a composable building block. It comes heavily bundled with a Java backend and relies on XMPP (via Prosody) for signaling.

- **Pros:** Feature-rich, production-ready for standalone deployments.
- **Cons:** My gateway is an extremely lightweight, stateless WebSocket + NATS router. Forcing a monolithic and legacy XMPP protocol stack into this environment not only fragments the existing user authentication system but fundamentally destroys the architectural elegance of Ocean.Chat.
- **Rejected:** Jitsi is a product, not a component. It is fundamentally incompatible with modern microservices.

### The Second Tier Dilemma: Mediasoup

Mediasoup offers extreme single-machine performance and immense flexibility through its Node.js control layer and C++ forwarding core.

- **Pros:** Unmatched single-node performance and low-level API control.
- **Cons:** Facing the vision of 100k concurrent streams, single-machine performance is meaningless. Mediasoup leaves all the complex distributed clustering challenges—such as node selection, cross-server cascading, and distributed state synchronization—entirely to the developer.
- **Rejected:** Building a high-availability WebRTC scheduler from scratch carries an enormous hidden cost and an unacceptably low ROI. Furthermore, tightly coupling C++ workers to Node.js processes breaks the purity of stateless containerized deployments.

## Consequences: The LiveKit Breakthrough

LiveKit represents the best practice for a cloud-native, distributed WebRTC architecture.

### Decoupling and Microservice Synergy

This is the most critical factor. LiveKit runs as a completely independent Go binary component, much like Redis or NATS. The NestJS business logic does not need to handle any complex WebRTC signaling (like SDP exchanges or ICE candidate negotiations).

Instead, the auth service simply signs a JWT token. The client takes this token and connects directly to the LiveKit server. This paradigm perfectly preserves the "stateless" nature of the existing Ocean.Chat business gateway.

### Native Clustering Capabilities

LiveKit utilizes Redis to manage room states and natively supports distributed node discovery and traffic routing. Scaling to handle 100k concurrency is simply a matter of horizontally adding more LiveKit nodes. There is no need to reinvent the wheel for cluster scheduling.

### Confronting the 100Gbps Bandwidth Bottleneck

LiveKit includes mature built-in Simulcast and Adaptive Bitrate (ABR) control algorithms. In medium-to-large Scope conferences, these features drastically reduce the server's egress bandwidth costs without requiring custom backend implementations.

### Out-of-the-Box Engineering Experience

LiveKit provides exceptionally high-quality SDKs across multiple platforms (Web, iOS, Android), which saves a massive amount of cross-platform integration time. Additionally, it offers native Egress capabilities for seamless recording and broadcasting.

## Conclusion

Architectural selection is not about blindly pursuing the absolute limits of a single machine; it is about ensuring the robustness of the entire system and maximizing R&D ROI. LiveKit's clean separation of signaling via JWTs and its cloud-native scalability make it the pragmatic choice for Ocean.Chat's future.
