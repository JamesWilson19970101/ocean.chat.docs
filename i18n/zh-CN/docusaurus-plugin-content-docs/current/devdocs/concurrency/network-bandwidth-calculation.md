---
id: network-bandwidth-calculation
title: 网络带宽与硬件测算指南
description: 学习如何计算 Ocean Chat 在 10 万并发下的网络带宽需求，并选择具体的网络硬件型号（网卡和交换机）。
keywords: [ocean chat, 网络带宽, 10GbE, 硬件, 网卡, 交换机, 吞吐量, 十万并发]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

> 参考文章
> - [3.1. Internet Header Format](https://ftp.nic.ad.jp/rfc/inline-errata/rfc791.html)
> - [3.1. Header Format](https://pike.lysator.liu.se/docs/ietf/rfc/92/rfc9293.xml)
> - [5.2. Base Framing Protocol](https://greenbytes.de/tech/webdav/rfc6455.pdf)
> - [IEEE 802.3 Ethernet Frame (包含 MAC, FCS, 前导码及 IPG 规范)](https://en.wikipedia.org/wiki/Ethernet_frame)
> - [IEEE 802.1Q (VLAN 标签规范)](https://en.wikipedia.org/wiki/IEEE_802.1Q)
> - [2.1. Header Layout](./Monkey%20Protocol/monkey-protocol-spec.md)

# 网络带宽与硬件测算指南

本指南详细介绍了如何计算支撑 Ocean Chat **100,000 并发连接**所需的确切网络带宽。它将这些数学需求转化为具体的物理硬件建议，包括网络接口卡 (NIC) 和网络交换机。

## 固定消耗

- TCP 固定开销：20 字节（Bytes）。不包含任何可选字段（如时间戳、窗口扩大因子等）的基础头部大小通常是20字节，由于通常会带上时间戳（Timestamp, 10 字节）等选项，TCP 头部经常是 32 字节。下文按照 32 字节计算。
- IPv4 固定开销为 20 字节。IPv6 固定开销为 40 字节。下文按照 20 字节计算。
- web 端是 ws 协议设计的 monkey 协议，手机端是 tcp 协议设计的 monkey 协议。ws 协议基础头部固定 2 字节，从“客户端”发往“服务端”的所有帧都必须包含 4 字节掩码。业务数据小于126字节，所以 ws 协议不需要长度扩展。下文统一按照 6 字节（按照多的计算）计算。
- 数据链路层：标准以太网帧头（MAC Header）为 14 字节。现代数据中心为实现租户网络隔离，通常会启用 IEEE 802.1Q VLAN，额外插入 4 字节的 VLAN 标签；再加上 4 字节的 FCS 帧尾校验序列，总开销按 22 字节计算。
- 物理层：数据包在网线上传输时，还包含隐形的物理传输开销，包括前导码 (Preamble) 7 字节、帧起始定界符 (SFD) 1 字节和帧间距 (IPG) 12 字节，固定总计 20 字节。

目前以 Web 端为例，网络传输数据时的底层协议固定开销长度为：**32(TCP) + 20(IP) + 6(WS) + 12(Monkey Header) = 70 字节**。

## 上下文：长短链协同效应

Ocean Chat 带宽计算中最关键的因素是控制面与数据面的严格分离：

1. **控制面 (Monkey Protocol/WebSocket):** 仅承载 12 字节头部和极轻量的 JSON/Protobuf 元数据（`MSG_UP`、`MSG_NOTIFY`、心跳）。
2. **数据面 (HTTP/OSS):** 大文件（图片、视频、语音）直接通过 CDN 上传至对象存储 (OSS/S3)。

**这意味着 IM 集群服务器绝对不会路由原始的多媒体二进制文件。** 集群仅路由轻量级文本和元数据，这极大地降低了为应付高并发消息请求所需的带宽。

## 第一步：计算基础吞吐量（数学推演）

为了评估网络规模，需要计算空闲状态和流量峰值下的吞吐量。

### 场景 A：空闲状态（心跳保活）

Ocean Chat 采用非对称心跳。服务端每 30 秒发送一次 Ping。
* **业务载荷:** 0 字节 (纯心跳包无附加数据，12 字节 Monkey Header 已计入下方)。
* **协议栈开销:** 70 字节 (TCP 32 + IPv4 20 + WS 6 + Monkey 12)。
* **数据链路层开销:** 22 字节 (14 字节 MAC 帧头 + 4 字节 802.1Q VLAN 标签 + 4 字节 FCS 校验)。
* **物理层隐形开销:** 20 字节 (7 字节前导码 + 1 字节 SFD + 12 字节 IPG 帧间距)。
* **单次心跳在网线上的真实物理占用:** 70 + 22 + 20 = 112 字节。

```text title="空闲带宽计算"
(100,000 连接 × 112 Bytes × 8 bits/Byte) / 30 秒 
= 2,986,666.67 bps ≈ 2.99 Mbps (兆比特每秒)
```
*结论:* 空闲连接几乎不消耗任何带宽。区区 2.99 Mbps 在千兆网络中完全可以忽略不计。

### 场景 B：流量峰值（活跃聊天）

假设全球峰值期间，各个大群每秒共发送 **10,000 条消息**。
* **上行 (`MSG_UP`):** 10,000 msgs/sec × ~300 Bytes (Header + Protobuf(300-112有效数据载荷，约为188个英文字符，62个utf-8中文字符)) × 8 = **~24 Mbps**。
* **下行推送 (`MSG_NOTIFY`):** 编排服务扇出通知。根据协议规范，`MSG_NOTIFY` 仅作唤醒不带实体，Payload 只包含 `GroupId`（字符串，约 20 字节）与 `SyncSeqId`（int64，约 8 字节），Protobuf 编码后约 30 字节。加上 112 字节底层物理网络开销，单包物理占用约 142 字节。假设 50,000 名在线用户同时收到通知：`50,000 × 142 Bytes × 8 = 56,800,000 bps ≈` **56.8 Mbps**。
* **HTTP Sync (数据拉取):** 收到通知后，50,000 个客户端通过 HTTP 拉取消息实体。假设 JSON 响应为 1KB。50,000 × 1,024 Bytes × 8 = **~409.6 Mbps**。

### 集群总带宽需求
* **边缘峰值总流量:** 24 + 56.8 + 409.6 = **~490.4 Mbps**。
* **内部微服务流量 (NATS 复制 + Redis):** 将边缘流量翻倍以涵盖内部路由和 Raft 共识复制 = **~980.8 Mbps**。

**最终测算:** 一个十万并发的 Ocean Chat 集群在极端流量峰值期间，大约需要 **1.5 Gbps 的稳定内/外部带宽容量**。

## 第二步：选择物理硬件

标准的 1 Gbps（千兆以太网）网卡会在 1.5 Gbps 的峰值流量下成为瓶颈。因此，**10GbE（万兆以太网）** 是物理硬件的绝对最低标准。

<Tabs>
  <TabItem value="nic" label="网络接口卡 (NICs)" default>
    对于物理服务器，选择支持 TCP 卸载引擎 (TOE) 和 SR-IOV 的网卡，以减少处理数百万小包时的 CPU 开销。

    * **标准选择: Intel X710-DA2 (双口 10GbE SFP+)**
      * *原因:* 裸金属 Kubernetes 节点的行业标准。Linux 下驱动支持可靠，DPDK 支持出色，可轻松应对 10Gbps 线速。
      * *淘宝:* 约 ￥350。[淘宝链接](https://item.taobao.com/item.htm?id=688301709448&skuId=5088418623349)。
    * **高性能替代: Mellanox ConnectX-4 Lx (10/25GbE)**
      * *原因:* Mellanox (现 Nvidia) 网卡在处理海量小包 (高 PPS - 每秒数据包数) 时比 Intel 拥有更低的延迟。强烈推荐用于 NATS JetStream 和 Redis 节点。
      * *淘宝:* 约 ￥450。[淘宝链接](https://item.taobao.com/item.htm?id=834255588855)
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
不使用传统的 Cat5e 网线连接 10GbE。机柜内的微服务通信应始终使用带有 SFP+ 模块的 **DAC（直连铜缆）** 或 **AOC（有源光缆）**。这保证了极低的延迟（亚微秒级）。
:::

## 预期结果

通过计算严格的控制面载荷大小，可以从数学上证明，十万并发的集群根本不需要昂贵的 100GbE 网络。标准的 **10GbE (Intel X710) 网络架构** 提供了 85% 的余量安全空间，确保网络带宽永远不会成为 Ocean Chat 的瓶颈。
