---
id: why-chose-livekit-over-mediasoup-and-jitsi
title: 为什么我放弃了 Mediasoup 和 Jitsi，最终选择 LiveKit 支撑 Ocean.Chat 的 10w 级音视频并发？
description: 关于在 Ocean.Chat 中选择 LiveKit 作为 WebRTC 核心架构，以支撑 10w 级并发流的架构决策记录（ADR）。
keywords: [ocean chat, adr, 架构决策, webrtc, livekit, mediasoup, jitsi, 微服务]
image: https://docs.oceanchat.com/img/social-card.png
tags: [ocean-chat, adr, decision-record]
---

# ADR: 为什么我放弃了 Mediasoup 和 Jitsi，最终选择 LiveKit 支撑 10w 级音视频并发？

代码层面暂时不去实现，等消息发送完成之后再引入livekit增加音视频的功能。

## Status (状态)

已接受 (Accepted)

## Date (日期)

2026-05-10

## Context (业务背景)

Ocean.Chat 是一款面向中小企业（SME）和特定「Scope（领域）」的定制化通讯平台。

目前我的技术栈基于 TypeScript 和 NestJS 构建微服务，使用 NATS JetStream 作为消息总线。

:::info 架构约束
核心业务拥有一个完全「无状态」的 WebSocket 网关。任何新引入的基础设施都必须严格保持这种无状态特性和极高的研发 ROI。
:::

我面临的技术挑战是：需要为平台引入高质量的多人音视频会议功能，且未来架构必须具备支撑 **10w 级并发流**（约 100Gbps 峰值带宽）的横向扩展能力。

## Decision (决策)

采用 **LiveKit** 作为核心 WebRTC SFU 基础设施，放弃早期的 Jitsi 和 Mediasoup 方案。

## Alternatives Considered (被淘汰的备选方案)

### 第一方阵被淘汰者：Jitsi

Jitsi 是一个完整的成品，而不是可以灵活组装的积木。它捆绑了沉重的 Java 后端，并且依赖古老的 XMPP (Prosody) 协议栈进行信令交互。

- **优点：** 功能大而全，开箱即用的完整产品。
- **缺点：** 我的网关是极其轻量的无状态 WebSocket + NATS 路由。强行塞入庞大且老旧的 XMPP 协议栈，不仅割裂了现有的用户体系，更破坏了整体架构的美感。
- **结论：** 淘汰。它与现代微服务八字不合。

### 第二方阵的纠结：Mediasoup

我必须承认 Mediasoup（Node.js 控制层 + C++ 转发核心）拥有极高的单机性能和 API 灵活性。

- **优点：** 极致的单机榨干能力和底层控制力。
- **缺点：** 面对 10w 并发的愿景，单机毫无意义。Mediasoup 把分布式集群调度的难题（如：节点选择、跨服级联、状态同步）全部留给了开发者。
- **结论：** 淘汰。自己手搓一个高可用调度的成本极高，ROI 太低，这是一个“隐藏的焦油坑”。此外，C++ Worker 绑定在 Node.js 进程上的模式，在无状态容器化部署时不够纯粹。

## Consequences (破局者：LiveKit)

LiveKit 展现了天生分布式的最佳实践，这也是最终选择它的核心原因。

### 解耦与微服务的高度契合

这是最关键的一点。LiveKit 作为一个完全独立的 Go 语言二进制组件运行，在架构中就像 Redis 或 NATS 一样纯粹。

我的业务逻辑（NestJS）不需要去处理极其复杂的 WebRTC 信令（如 SDP 交换、ICE 候选者收集），只需要负责鉴权并签发一个 JWT Token。客户端拿着这个 Token 直接连接 LiveKit 节点即可。这完美保持了现有业务网关的绝对“无状态”。

### 原生的集群能力

LiveKit 利用 Redis 管理房间状态，原生支持分布式节点发现和流量路由。面对 10w 并发的挑战，我只需要简单地增加机器就能扛住，完全不需要从零造调度轮子。

### 直面 100Gbps 的带宽瓶颈

LiveKit 内置了成熟的 Simulcast（联播）和动态码率控制（ABR）算法。在几十人的 Scope 会议中，这能极大节省服务器的下行带宽成本，直击高并发场景下的成本痛点。

### 开箱即用的工程体验

它提供了极高质量的多端 SDK（Web, iOS, Android），省去了大量前端和移动端的联调时间。同时，原生的 Egress 录制能力也让后续功能的延展变得异常轻松。

## 结语

架构选型绝不是盲目追求单机性能的极致榨干，而是追求整体架构的稳健与研发 ROI。LiveKit 通过 JWT 优雅解耦了信令，并提供了开箱即用的云原生集群能力，是 Ocean.Chat 务实且长远的最优解。
