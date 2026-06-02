---
id: network-bandwidth-calculation
title: Network Bandwidth & Hardware Sizing Guide
sidebar_position: auto
description: Learn how to calculate the network bandwidth required for 100,000 concurrent Ocean Chat users and select specific hardware models (NICs and Switches).
keywords: [ocean chat, network bandwidth, 10GbE, hardware, NIC, switch, throughput, 100k connections]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Network Bandwidth & Hardware Sizing Guide

This guide details how to calculate the exact network bandwidth required to support **100,000 concurrent connections** in Ocean Chat. It translates these mathematical requirements into specific physical hardware recommendations, including Network Interface Cards (NICs) and network switches.

:::tip Problem-Oriented
This is a **How-to Guide**. It assumes you have read the architecture documentation and now need to procure bare-metal networking hardware or provision cloud instances.
:::

## Context: The Long/Short Connection Synergy

The most critical factor in Ocean Chat's bandwidth calculation is the strict separation of the control plane and data plane:

1. **Control Plane (Monkey Protocol/WebSocket):** Only carries 12-byte headers and lightweight JSON/Protobuf metadata (`MSG_UP`, `MSG_NOTIFY`, Heartbeats).
2. **Data Plane (HTTP/OSS):** Large files (images, videos, voice notes) are uploaded directly to Object Storage (OSS/S3) via a CDN. 

**This means the IM cluster servers NEVER route raw multimedia binaries.** The cluster only routes lightweight text and metadata, drastically reducing the required bandwidth.

## Step 1: Calculate Baseline Throughput (The Math)

To size the network, calculate the throughput for both idle states and traffic spikes.

### Scenario A: Idle State (Heartbeats)

Ocean Chat utilizes an asymmetric heartbeat. The server sends a Ping every 30 seconds.
* **Payload:** 12 bytes (Monkey Protocol Header) + 0 bytes Payload.
* **TCP/IP Overhead:** ~54 bytes (Ethernet frame, IPv4 header, TCP header).
* **Total Packet Size:** ~66 bytes per heartbeat.

```text title="Idle Bandwidth Calculation"
(100,000 connections × 66 Bytes × 8 bits/Byte) / 30 seconds 
= ~1.76 Mbps (Megabits per second)
```
*Conclusion:* Idle connections consume virtually zero bandwidth. 1.76 Mbps is negligible.

### Scenario B: Traffic Spike (Active Messaging)

Assume a global peak where **10,000 messages** are sent per second across various large groups.
* **Upstream (`MSG_UP`):** 10,000 msgs/sec × ~300 Bytes (Header + Protobuf) × 8 = **~24 Mbps**.
* **Downstream (`MSG_NOTIFY`):** The orchestrator fans out notifications. Assume 50,000 online users receive a notify. 50,000 × 100 Bytes × 8 = **~40 Mbps**.
* **HTTP Sync (Data Fetch):** Following the notify, 50,000 clients fetch the message entity via HTTP. Assume the JSON response is 1KB. 50,000 × 1,024 Bytes × 8 = **~400 Mbps**.

### Total Cluster Bandwidth Required
* **Total Peak Edge Traffic:** 24 + 40 + 400 = **~464 Mbps**.
* **Internal Microservice Traffic (NATS Replication + Redis):** Double the edge traffic for internal routing and Raft consensus replication = **~928 Mbps**.

**Final Sizing:** A 100k concurrency Ocean Chat cluster requires approximately **1.5 Gbps of stable internal/external bandwidth capacity** during extreme traffic spikes.

## Step 2: Select Physical Hardware

Standard 1 Gbps (Gigabit Ethernet) network cards will bottleneck at peak 1.5 Gbps traffic. Therefore, **10GbE (10 Gigabit Ethernet)** is the absolute minimum standard for the physical hardware.

<Tabs>
  <TabItem value="nic" label="Network Interface Cards (NICs)" default>
    For physical servers, select NICs that support TCP Offload Engine (TOE) and SR-IOV to reduce CPU overhead when handling millions of small packets.

    * **Standard Choice: Intel X710-DA2 (Dual Port 10GbE SFP+)**
      * *Why:* The industry standard for bare-metal Kubernetes nodes. Reliable driver support in Linux, excellent DPDK support, and easily handles 10Gbps line rate.
    * **High-Performance Alternative: Mellanox ConnectX-4 Lx (10/25GbE)**
      * *Why:* Mellanox (now Nvidia) cards excel at processing massive amounts of small packets (high PPS - Packets Per Second) with lower latency than Intel. Highly recommended for the NATS JetStream and Redis nodes.
  </TabItem>

  <TabItem value="switch" label="Network Switches (Top-of-Rack)">
    The Top-of-Rack (ToR) switch must have non-blocking throughput to ensure microservice RPC calls do not suffer from buffer drops.

    * **Standard Choice: Cisco Nexus 93180YC-EX**
      * *Why:* Provides 48 ports of 10/25GbE with ultra-low latency. Perfect for a single-rack IM cluster deployment.
    * **Budget Choice: MikroTik CRS326-24S+2Q+RM**
      * *Why:* Features 24 10Gbps SFP+ ports. At under $600, it is an unbeatable choice for startups building physical clusters, easily handling the required 1.5 Gbps backplane routing.
  </TabItem>
</Tabs>

:::warning Cabling Matters
Do not use legacy Cat5e Ethernet cables for 10GbE. Always use **DAC (Direct Attach Copper)** cables or **AOC (Active Optical Cables)** with SFP+ transceivers for intra-rack microservice communication. This guarantees minimal latency (sub-microsecond).
:::

## Step 3: Cloud Provider Equivalents

If deploying to public clouds instead of purchasing bare metal, ensure the chosen instances guarantee baseline networking.

* **AWS (Amazon Web Services):**
  * Use **c6i.2xlarge** or **m6i.2xlarge** instances. These provide "Up to 12.5 Gbps" network bandwidth, easily covering the 1.5 Gbps requirement. Ensure **ENA (Elastic Network Adapter)** is enabled to handle the high Packets-Per-Second (PPS).
* **Aliyun (Alibaba Cloud):**
  * Use **ecs.g7.2xlarge** instances. These guarantee baseline bandwidth of 2.5 Gbps and maximum burst up to 10 Gbps, which perfectly matches the calculated peak throughput.

## Expected Result

By calculating the strict control-plane payload sizes, it is mathematically proven that a 100k concurrency cluster does not require exotic 100GbE networking. A standard **10GbE (Intel X710) network fabric** provides an 85% headroom safety margin, ensuring that network bandwidth will never be the bottleneck for Ocean Chat.
