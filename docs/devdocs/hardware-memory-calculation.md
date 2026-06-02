---
id: hardware-memory-calculation
title: Hardware Memory & Cluster Sizing Guide
sidebar_position: auto
description: Learn how to calculate the hardware and memory resources required to support 100,000 concurrent WebSocket connections on standard 8-core/4GB machines.
keywords: [ocean chat, hardware, memory, concurrency, cluster sizing, ddr4, ddr5, 100k connections]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Hardware Memory & Cluster Sizing Guide: Supporting 100k Concurrency

This guide walks through the process of calculating and estimating the hardware resources—specifically memory—required to support **100,000 concurrent WebSocket connections** for Ocean Chat.

It focuses on a common hardware profile: **8-core CPU / 4GB RAM** machines. You will learn how to size the cluster, evaluate DDR4 vs. DDR5 memory, and identify the true bottlenecks in a high-concurrency IM system.

:::tip Problem-Oriented
This is a **How-to Guide**. It assumes you understand the Ocean Chat architecture and need to translate those requirements into a physical hardware deployment plan.
:::

## Step 1: Calculating Stateful Gateway Memory

The most memory-intensive part of any IM system is maintaining active TCP/WebSocket connections. `oceanchat-ws-gateway` is the only stateful edge node.

### The Math of WebSockets
In a Node.js environment, an idle WebSocket connection (including underlying TCP buffers and V8 object overhead) consumes approximately **30KB to 50KB** of resident memory. To be safe, use an average of **40KB**.

* **100,000 connections × 40KB = ~4,000,000 KB ≈ 4 GB**

### The 8-Core/4GB Dilemma
If 100,000 connections require 4GB of memory, a single 4GB machine would crash immediately due to Out-Of-Memory (OOM) errors. 
Furthermore, **8-core / 4GB** is a memory-starved ratio. Using Node.js Cluster mode (8 workers) means:
* 4GB Total / 8 Workers = **~500MB per worker**.
* If one machine handles 100,000 connections, each worker handles 12,500 connections (filling the 500MB). Any Garbage Collection (GC) activity would likely trigger OOM.

**Conclusion:**
To safely handle 100k connections on 4GB machines, distribute the load to keep memory utilization below 60%.
* Safe capacity per 4GB machine: **~30,000 to 40,000 connections**.
* **Nodes Required:** **3 nodes** (each handling ~33k connections, consuming ~1.3GB RAM).

## Step 2: Calculating Redis Presence Memory

`oceanchat-presence` relies on Redis to store the global routing map.

### Per-User Footprint
We use a Redis Hash (`user:routing:{userId}`) to store a small JSON object containing `gatewayId` and device metadata.
* Size per online user: ~150 Bytes.
* **100,000 users × 150 Bytes = ~15 MB**.

Even with Redis overhead and ZSETs for unread counts (500 messages per group), total memory for 100k concurrency rarely exceeds **200 MB**.

**Conclusion:**
A single 4GB machine is massive overkill for the memory needs of 100k presence states.
* **Nodes Required:** **1 node** (or 3 for high-availability Sentinel).

## Step 3: Stateless Services & Message Queue

### NATS JetStream
NATS is written in Go and is extremely memory-efficient (~100MB footprint). Because Ocean Chat uses `StorageType.File` for WAL, NATS relies on disk I/O and the OS Page Cache rather than application-level RAM.
* **Nodes Required:** **3 nodes** (for Raft consensus). 4GB is plenty.

### Core Business Services (Auth, Message, Router)
These are **CPU-bound**, not memory-bound. Your **8 cores** are the star here. RS256 signing and Protobuf decoding are CPU-intensive.
* Memory footprint per Node.js process: 200MB - 400MB.
* **Nodes Required:** **3 nodes** (Services can be co-located or containerized).

## Step 4: DDR4 vs. DDR5 Decision

Should you pay the premium for DDR5 for a 100k concurrency IM system?

<Tabs>
  <TabItem value="ddr4" label="DDR4 (3200 MT/s)" default>
    **Verdict: Perfectly Sufficient.**
    100k users sending a 1KB message every 10s results in ~10MB/s peak throughput. DDR4 bandwidth (~25GB/s) is massive overkill. DDR4 often has lower latency (CL16), which is actually better for Redis's fragmented small-packet lookups.
  </TabItem>
  <TabItem value="ddr5" label="DDR5 (4800+ MT/s)">
    **Verdict: Luxury with Diminishing Returns.**
    DDR5 offers incredible bandwidth for AI training or video rendering. An IM system does not move large contiguous memory blocks. Save your budget for better NVMe SSDs instead.
  </TabItem>
</Tabs>

:::warning SSD over RAM Generation
For IM platforms, **Disk I/O (NVMe SSD)** is far more important than DDR5. NATS WAL and MongoDB Bulk Writes depend entirely on high IOPS.
:::

## Summary: 100k Concurrency Blueprint

Based on **8-core / 4GB RAM** machines, here is the high-availability blueprint:

| Subsystem | Nodes (4GB/8C) | Primary Bottleneck | Est. RAM Usage |
| :--- | :--- | :--- | :--- |
| **WS Gateway** | 3 | **Memory** (Sockets) | ~50% (2GB / 4GB) |
| **NATS MQ** | 3 | Disk I/O & Network | ~5% (200MB / 4GB) |
| **Stateless Services** | 3 | **CPU** (Logic/Crypto) | ~60% (2.5GB / 4GB) |
| **Redis Cache** | 1 | Memory | ~5% (200MB / 4GB) |
| **MongoDB** | 3 (Replica) | Disk I/O | ~80% (OS Page Cache) |
| **Total Cluster** | **~13 nodes** | - | - |

By following the Ocean Chat I/O decoupling strategy, a cluster of **13 standard 4G/8C PCs** can easily support 100,000 world-class concurrent connections.
