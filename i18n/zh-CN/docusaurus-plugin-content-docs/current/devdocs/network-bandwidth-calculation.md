---
id: network-bandwidth-calculation
title: 网络带宽与硬件测算指南
sidebar_position: auto
description: 学习如何计算 Ocean Chat 在 10 万并发下的网络带宽需求，并选择具体的网络硬件型号（网卡和交换机）。
keywords: [ocean chat, 网络带宽, 10GbE, 硬件, 网卡, 交换机, 吞吐量, 十万并发]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# 网络带宽与硬件测算指南

本指南详细介绍了如何计算支撑 Ocean Chat **100,000 并发连接**所需的确切网络带宽。它将这些数学需求转化为具体的物理硬件建议，包括网络接口卡 (NIC) 和网络交换机。

:::tip 问题导向
这是一篇 **How-to Guide (操作指南)**。它假定你已经阅读了架构文档，现在需要采购裸金属网络硬件或配置云服务器实例。
:::

## 上下文：长短链协同效应

Ocean Chat 带宽计算中最关键的因素是控制面与数据面的严格分离：

1. **控制面 (Monkey Protocol/WebSocket):** 仅承载 12 字节头部和极轻量的 JSON/Protobuf 元数据（`MSG_UP`、`MSG_NOTIFY`、心跳）。
2. **数据面 (HTTP/OSS):** 大文件（图片、视频、语音）直接通过 CDN 上传至对象存储 (OSS/S3)。

**这意味着 IM 集群服务器绝对不会路由原始的多媒体二进制文件。** 集群仅路由轻量级文本和元数据，这极大地降低了所需的带宽。

## 第一步：计算基础吞吐量（数学推演）

为了评估网络规模，需要计算空闲状态和流量峰值下的吞吐量。

### 场景 A：空闲状态（心跳保活）

Ocean Chat 采用非对称心跳。服务端每 30 秒发送一次 Ping。
* **载荷:** 12 字节 (Monkey Protocol Header) + 0 字节 Payload。
* **TCP/IP 开销:** 约 54 字节 (以太网帧、IPv4 头部、TCP 头部)。
* **总数据包大小:** 每次心跳约 66 字节。

```text title="空闲带宽计算"
(100,000 连接 × 66 Bytes × 8 bits/Byte) / 30 秒 
= ~1.76 Mbps (兆比特每秒)
```
*结论:* 空闲连接几乎不消耗任何带宽。1.76 Mbps 可以忽略不计。

### 场景 B：流量峰值（活跃聊天）

假设全球峰值期间，各个大群每秒共发送 **10,000 条消息**。
* **上行 (`MSG_UP`):** 10,000 msgs/sec × ~300 Bytes (Header + Protobuf) × 8 = **~24 Mbps**。
* **下行推送 (`MSG_NOTIFY`):** 编排服务扇出通知。假设 50,000 名在线用户收到通知。50,000 × 100 Bytes × 8 = **~40 Mbps**。
* **HTTP Sync (数据拉取):** 收到通知后，50,000 个客户端通过 HTTP 拉取消息实体。假设 JSON 响应为 1KB。50,000 × 1,024 Bytes × 8 = **~400 Mbps**。

### 集群总带宽需求
* **边缘峰值总流量:** 24 + 40 + 400 = **~464 Mbps**。
* **内部微服务流量 (NATS 复制 + Redis):** 将边缘流量翻倍以涵盖内部路由和 Raft 共识复制 = **~928 Mbps**。

**最终测算:** 一个十万并发的 Ocean Chat 集群在极端流量峰值期间，大约需要 **1.5 Gbps 的稳定内/外部带宽容量**。

## 第二步：选择物理硬件

标准的 1 Gbps（千兆以太网）网卡会在 1.5 Gbps 的峰值流量下成为瓶颈。因此，**10GbE（万兆以太网）** 是物理硬件的绝对最低标准。

<Tabs>
  <TabItem value="nic" label="网络接口卡 (NICs)" default>
    对于物理服务器，选择支持 TCP 卸载引擎 (TOE) 和 SR-IOV 的网卡，以减少处理数百万小包时的 CPU 开销。

    * **标准选择: Intel X710-DA2 (双口 10GbE SFP+)**
      * *原因:* 裸金属 Kubernetes 节点的行业标准。Linux 下驱动支持可靠，DPDK 支持出色，可轻松应对 10Gbps 线速。
    * **高性能替代: Mellanox ConnectX-4 Lx (10/25GbE)**
      * *原因:* Mellanox (现 Nvidia) 网卡在处理海量小包 (高 PPS - 每秒数据包数) 时比 Intel 拥有更低的延迟。强烈推荐用于 NATS JetStream 和 Redis 节点。
  </TabItem>

  <TabItem value="switch" label="网络交换机 (Top-of-Rack)">
    架顶式 (ToR) 交换机必须具备无阻塞吞吐能力，以确保微服务 RPC 调用不会因缓冲区丢包而受损。

    * **标准选择: Cisco Nexus 93180YC-EX**
      * *原因:* 提供 48 个 10/25GbE 端口，具有超低延迟。完美适用于单机柜 IM 集群部署。
    * **预算选择: MikroTik CRS326-24S+2Q+RM**
      * *原因:* 提供 24 个 10Gbps SFP+ 端口。价格不到 600 美元，是初创公司构建物理集群的无敌性价比之选，轻松处理所需的 1.5 Gbps 背板路由。
  </TabItem>
</Tabs>

:::warning 线缆至关重要
千万不要使用传统的 Cat5e 网线连接 10GbE。机柜内的微服务通信应始终使用带有 SFP+ 模块的 **DAC（直连铜缆）** 或 **AOC（有源光缆）**。这保证了极低的延迟（亚微秒级）。
:::

## 第三步：云服务商对标

如果部署在公有云而不是采购裸金属，请确保所选实例保证了基础网络性能。

* **AWS (亚马逊云):**
  * 使用 **c6i.2xlarge** 或 **m6i.2xlarge** 实例。这些实例提供“最高 12.5 Gbps”的网络带宽，轻松满足 1.5 Gbps 的需求。确保启用 **ENA (Elastic Network Adapter)** 以处理高 PPS。
* **Aliyun (阿里云):**
  * 使用 **ecs.g7.2xlarge** 实例。这些实例保证 2.5 Gbps 的基础带宽和最高 10 Gbps 的突发带宽，完美匹配计算出的峰值吞吐量。

## 预期结果

通过计算严格的控制面载荷大小，可以从数学上证明，十万并发的集群根本不需要昂贵的 100GbE 网络。标准的 **10GbE (Intel X710) 网络架构** 提供了 85% 的余量安全空间，确保网络带宽永远不会成为 Ocean Chat 的瓶颈。
