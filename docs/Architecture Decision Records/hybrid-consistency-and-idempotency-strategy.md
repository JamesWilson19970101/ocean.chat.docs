---
id: hybrid-consistency-and-idempotency-strategy
title: Hybrid Consistency and Idempotency Strategy
description: Architectural decision to implement a tiered consistency model across Ocean Chat business modules, balancing performance with strong consistency where necessary.
keywords:
  [
    ocean chat,
    adr,
    decision-record,
    consistency,
    idempotency,
    mongodb transactions,
    eventual consistency,
    redis lua,
  ]
tags: ["ocean-chat", "adr", "decision-record"]
---

# Architecture Decision Record: Hybrid Consistency and Idempotency Strategy

## Status

**Accepted**

## Date

2026-05-24

## Context

In a large-scale distributed IM system like Ocean Chat, different business scenarios have vastly different requirements for consistency and performance. A "one-size-fits-all" approach—such as using distributed transactions for everything or eventually consistent patterns everywhere—leads to either unacceptable latency in hot paths or excessive development complexity for simple administrative tasks.

I need a strategy that optimizes for user experience (low latency) during high-frequency events while ensuring data integrity for critical core operations.

## Decision

Ocean Chat will adopt a tiered, hybrid consistency model tailored to the specific business impact and frequency:

### 1. Hot Business Paths (Messaging, Status Sync)

**Strategy:** Abandon multi-document transactions entirely.

- **Mechanism:** Utilize database single-document atomic operations (e.g., MongoDB `$inc`, `$set`) combined with Message Queue (MQ) asynchronous dispatch.
- **Consistency Model:** Eventual Consistency.
- **Mandatory Requirements:**
  - **Full-Link Idempotency:** Every transition and state update must carry a unique `IdempotencyKey`. The system must guarantee that multiple executions yield the same result as a single execution.
  - **Safety Nets:** Implementation of Dead Letter Queues (DLQ) for failed operations and offline reconciliation/compensation mechanisms to resolve edge-case discrepancies.

### 2. Cold Core Business (Team Creation, User Registration)

**Strategy:** Embrace MongoDB Native Multi-document Transactions.

- **Mechanism:** Standard ACID transactions within MongoDB.
- **Consistency Model:** Strong Consistency.
- **Rationale:** These operations are low-frequency. Using native transactions minimizes development cost and complexity while providing the highest level of data integrity for foundational entities.

### 3. High-Frequency Financial/Inventory Operations (Future)

**Strategy:** In-Memory Atomic Operations + Async Persistence.

- **Mechanism:** Use Redis Lua scripts for memory-based atomic reductions (e.g., to prevent overselling) followed by MQ-driven asynchronous accounting and database storage.
- **Requirement:** Strict deduplication logic at the MQ consumer level.

### 4. Distributed Foundation Principles

- **Idempotent Consumers:** All asynchronous message consumers must be idempotent by design.
- **Safety Safeguards:** Every eventual consistency link must be backed by either a DLQ or a reconciliation/compensation script as a safety floor.

## Rationale

- **Performance:** Removing transaction overhead from the "Send Message" path is critical for maintaining sub-100ms latency at scale.
- **Developer Velocity:** Using transactions for cold paths like "Create Group" allows for simpler code without the need for complex state machines or manual rollbacks.
- **Reliability:** By enforcing `IdempotencyKey` and DLQ patterns, the system remains resilient to network partitions and service restarts without resulting in permanent data corruption or "deadlocks" in business logic.

## Alternatives Considered

### Global Distributed Transactions (2PC/Saga)

- **Pros:** Unified consistency model.
- **Cons:** 2PC is too slow for IM messaging; Sagas introduce massive state management overhead for simple operations.
- **Rejected:** The latency impact on hot paths is unacceptable for the user experience.

### Pure Eventual Consistency

- **Pros:** Highly scalable.
- **Cons:** Over-engineers simple tasks. Building a compensation flow for a simple "User Registration" adds unnecessary time-to-market delay.
- **Rejected:** Strong consistency is cheaper and safer for low-frequency core data.

## Consequences

- Business logic for hot paths becomes more complex, requiring explicit idempotency checks.
- Developers must distinguish between "Hot" and "Cold" business paths during the design phase.
- Operational overhead increases slightly due to the need for monitoring DLQs and running periodic reconciliation scripts.
- Data integrity becomes "mathematically guaranteed" through idempotency rather than relying on database locks.
