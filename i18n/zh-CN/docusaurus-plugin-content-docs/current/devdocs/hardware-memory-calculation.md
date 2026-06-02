---
id: hardware-memory-calculation
title: 硬件内存与集群测算指南
sidebar_position: auto
description: 详细指导如何针对 100,000 个并发 WebSocket 连接，在标准的 8核4G 机器环境下进行硬件内存与集群规模测算。
keywords: [ocean chat, 硬件, 内存, 并发, 集群测算, ddr4, ddr5, 十万并发]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# 硬件内存与集群测算指南：支撑十万并发

本指南将带你一步步计算并推演支撑 **100,000 并发 WebSocket 连接** 的 Ocean Chat 集群到底需要多少内存和硬件资源。

测算将针对常见的 **8核 CPU / 4GB 内存** 机器进行。你将学习如何规划集群规模、评估 DDR4 与 DDR5 内存的选择，并识别高并发 IM 系统中真实的性能瓶颈。

:::tip 问题导向
这是一篇 **How-to Guide (操作指南)**。它假定你已经了解 Ocean Chat 的架构，现在需要将其需求转化为物理硬件部署方案。
:::

## 第一步：测算状态网关内存

IM 系统中最消耗内存的部分是维持活跃的 TCP/WebSocket 长连接。`oceanchat-ws-gateway` 是我们唯一的有状态边缘节点。

### WebSocket 的底层数学
在 Node.js 环境下，维持一个空闲的 WebSocket 连接（包含底层的 TCP 缓冲区以及 V8 引擎的对象开销），大约需要消耗 **30KB 到 50KB** 的物理内存。为了安全起见，我们取均值 **40KB** 进行计算。

* **100,000 个连接 × 40KB = ~4,000,000 KB ≈ 4 GB**

### 8核4G 机器的窘境
如果 10 万个连接光是 Socket 句柄就需要整整 4GB 内存，单台 4GB 的机器会立刻因为内存溢出 (OOM) 而崩溃。
此外，**8核 / 4GB** 是一个严重的内存瓶颈配比。开启 Node.js Cluster 模式（8 个 Worker 进程）意味着：
* 4GB 总内存 / 8 个 Worker = **每个进程仅分到 ~500MB 内存**。
* 如果让一台机器扛 10 万连接，每个 Worker 要处理 12,500 个连接（塞满 500MB）。一旦 V8 引擎触发垃圾回收 (GC)，极易导致 OOM。

**测算结论：**
为了在 4GB 机器上安全承载 10 万连接，必须分散负载，将内存利用率控制在 60% 以下。
* 建议单台 4GB 机器安全容量：**~30,000 到 40,000 个连接**。
* **所需机器数量：** **3 台**（每台承载约 3.3 万连接，消耗约 1.3GB 内存）。

## 第二步：测算 Redis 状态缓存内存

`oceanchat-presence` 依赖 Redis 存储全局路由图谱。

### 单用户内存足迹
我们使用 Redis Hash (`user:routing:{userId}`) 存储一段包含 `gatewayId` 和设备元数据的 JSON。
* 单个在线用户占用：约 150 Bytes。
* **100,000 在线用户 × 150 Bytes = ~15 MB**。

即便算上 Redis 的内部开销，以及用于未读数计算的 ZSET（每个群保留 500 条消息 ID），在十万并发下，Redis 总内存消耗也极少超过 **200 MB**。

**测算结论：**
对于十万并发的内存状态而言，一台 4GB 的机器属于**性能严重过剩**。
* **所需机器数量：** **1 台**（若需高可用，可部署 3 台组成 Sentinel 哨兵集群）。

## 第三步：无状态服务与消息队列

### NATS JetStream (消息队列)
NATS 由 Go 编写，内存管理极其高效（~100MB 占用）。由于 Ocean Chat 的 WAL 预写日志使用 `StorageType.File`，NATS 依赖磁盘 I/O 和 OS Page Cache，而非消耗应用层内存。
* **所需机器数量：** **3 台**（用于 Raft 集群）。4GB 内存绰绰有余。

### 核心业务微服务 (Auth, Message, Router)
这些服务是 **CPU 密集型**，而非内存密集型。你的 **8 个核心** 在这里是绝对主角。RS256 验签和 Protobuf 解码都非常消耗 CPU。
* 单个 Node.js 进程内存占用：200MB - 400MB。
* **所需机器数量：** **3 台**（建议混合部署或容器化部署）。

## 第四步：DDR4 vs. DDR5 内存世代决断

是否有必要为十万并发的 IM 系统购买昂贵的 DDR5 内存？

<Tabs>
  <TabItem value="ddr4" label="DDR4 (3200 MT/s)" default>
    **结论：完全胜任。**
    100k 用户每 10 秒发一条 1KB 消息，峰值吞吐仅约 10MB/s。DDR4 的带宽 (~25GB/s) 绰绰有余。DDR4 通常具有更低的时序 (CL16)，这对 Redis 处理海量碎片化小包查询反而更有利。
  </TabItem>
  <TabItem value="ddr5" label="DDR5 (4800+ MT/s)">
    **结论：边际效用递减的奢侈品。**
    DDR5 为 AI 训练或视频渲染提供了恐怖的带宽。但 IM 系统不需要搬运海量连续内存块。应该把这部分预算省下来，去购买性能更好的 NVMe 固态硬盘 (SSD)。
  </TabItem>
</Tabs>

:::warning SSD 远比内存世代重要
对于 IM 平台，**磁盘 I/O (NVMe SSD)** 的重要性远超 DDR5。NATS WAL 和 MongoDB 的批量写入性能完全取决于磁盘 IOPS。
:::

## 总结：十万并发集群分配表

基于 **8核 / 4GB 内存** 机器的最终部署蓝图：

| 子系统 | 机器数量 (4GB/8C) | 核心瓶颈点 | 预估物理内存利用率 |
| :--- | :--- | :--- | :--- |
| **WS 长连接网关** | 3 | **内存** (海量 Sockets) | ~50% (2GB / 4GB) |
| **NATS MQ 集群** | 3 | 磁盘 I/O 与网络 | ~5% (200MB / 4GB) |
| **无状态业务服务** | 3 | **CPU** (逻辑/加密) | ~60% (2.5GB / 4GB) |
| **Redis 状态缓存** | 1 | 内存 | ~5% (200MB / 4GB) |
| **MongoDB 数据库** | 3 (副本集) | 磁盘 I/O | ~80% (OS Page Cache) |
| **集群总计** | **~13 台机器** | - | - |

通过 Ocean Chat 的 I/O 解耦架构，仅需 **13 台极其普通的 4G/8核 电脑**，即可构建出支撑十万级并发的世界级 IM 后端集群。
