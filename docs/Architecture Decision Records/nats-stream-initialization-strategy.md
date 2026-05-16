---
id: nats-stream-initialization-strategy
title: NATS Stream Initialization Strategy
description: Rationale behind lazy initialization of NATS streams via code to optimize for low-resource environments.
keywords: [ocean-chat, adr, decision-record, nats, jetstream, optimization]
image: https://docs.oceanchat.com/img/social-card.png
tags: ["ocean-chat", "adr", "decision-record"]
---

# NATS Stream Initialization Strategy

## Status

Accepted

## Date

2026-05-14

## Context

The Ocean Chat system utilizes NATS JetStream for message persistence and delivery. Traditionally, streams are pre-configured in the NATS configuration file. However, this project aims to be accessible to developers with limited hardware resources (low memory, limited bandwidth). A monolithic NATS configuration with numerous pre-defined streams could lead to higher memory consumption and slower startup times.

I want to minimize the footprint of the development environment so that users with low-end computers can run the project smoothly with fewer downloads and lower memory overhead.

## Decision

Instead of defining all NATS streams in a central configuration file, the system adopts a "Lazy Initialization" strategy. Each microservice is responsible for checking, creating, and initializing the NATS streams it requires through code (using the NATS JS/TS client) during its startup sequence.

## Alternatives Considered

### Centralized NATS Configuration

- **Pros:** Clear overview of all infrastructure components in a single file.
- **Cons:** Increases the memory footprint of the NATS instance from the start; requires manual updates whenever a new service or stream is added; less friendly to local development on low-spec machines.
- **Rejected:** The overhead of managing a large, static configuration outweighs the benefits for this project's target audience.

### Infrastructure-as-Code (Terraform/Ansible)

- **Pros:** Highly professional, automated, and reproducible infrastructure management.
- **Cons:** Adds another layer of complexity and additional dependencies for developers; significantly increases the initial setup time and resource requirements.
- **Rejected:** Too heavy for a project focused on developer accessibility and low resource usage.

## Consequences

- **Resource Efficiency:** The NATS instance starts with a minimal footprint, consuming only what is absolutely necessary for the active services.
- **Developer Experience:** Simplifies the setup process; developers don't need to learn NATS configuration syntax or manage complex files to get started.
- **Code Ownership:** Services manage their own infrastructure dependencies, promoting a more decoupled and autonomous architecture.
- **Initialization Check:** A slight increase in service startup time as each service verifies its required streams.
- **Idempotency:** NATS stream creation is idempotent, so multiple service instances can safely perform this check without causing errors.
