# 消息发送与落库

---

id: message-sending-persistence-flow
title: 消息发送与落库流程
sidebar_label: 消息发送流程
sidebar_position: auto
description: 指南：Ocean Chat 微服务与 JetStream 如何协同工作，处理十万级并发下的消息发送与异步落库。
keywords: [ocean chat, 消息发送, 落库, 持久化, 微服务, nats jetstream, wal, 写屏障]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]

---

## 如何架构十万级并发下的消息发送与落库

为了支撑十万级并发连接，传统的同步数据库写入（即阻塞客户端，直到数据库保存消息完毕）会导致严重的性能瓶颈。Ocean Chat 采用基于 NATS JetStream 的 预写日志 (WAL) 模式来解决此问题。

本指南详细介绍了实现高吞吐量、异步消息发送和持久化所需的具体微服务、JetStream 主题以及循序渐进的数据流转过程。

## 必需的核心组件

要完成消息发送和落库的生命周期，需要特定的无状态微服务与有状态的 JetStream Stream 相互配合。

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="services" label="必需的微服务" default>

1.  连接网关 (oceanchat-ws-gateway)：无状态边缘节点。接收 WebSocket 的 MSG_UP 数据帧，剥离传输层，并直接转发原始负载。
2.  路由服务 (oceanchat-router)：流量调度器。拉取原始数据包，解码 Protobuf，并将其路由到正确的业务服务（单聊或群聊）。
3.  消息逻辑服务 (oceanchat-message)：业务大脑。负责权限校验、内容过滤以及分配全局唯一的 SeqId。它负责把控写屏障 (Write Fence)。
4.  数据管道 Worker (MessagePersistence)：后台消费者。从 NATS 批量拉取消息并写入 MongoDB。

  </TabItem>
