---
id: nats-stream-initialization-strategy
title: NATS Stream 初始化策略
description: 关于通过代码延迟初始化 NATS stream 以优化低资源环境运行效率的决策依据。
keywords: [ocean-chat, adr, decision-record, nats, jetstream, optimization]
image: https://docs.oceanchat.com/img/social-card.png
tags: ["ocean-chat", "adr", "decision-record"]
---

# NATS Stream 初始化策略

## 状态

已接受 (Accepted)

## 日期

2026-05-14

## 背景

Ocean Chat 系统使用 NATS JetStream 进行消息持久化和投递。传统做法是在 NATS 配置文件中预先配置 Stream。然而，本项目旨在让硬件资源有限（低内存、有限带宽）的开发者也能轻松运行。如果在 NATS 配置文件中定义大量 Stream，会导致更高的内存消耗和较慢的启动速度。

我希望尽量减少开发环境的占用空间，使低配电脑用户能以更少的下载量和更低的内存开销流畅运行该项目。

## 决策

系统采用“延迟初始化”策略，而不是在中央配置文件中定义所有 NATS Stream。每个微服务在启动序列中，通过代码（使用 NATS JS/TS 客户端）负责检查、创建和初始化其所需的 NATS Stream。

## 备选方案

### 集中式 NATS 配置

- **优点：** 在单个文件中可以清晰地概览所有基础设施组件。
- **缺点：** 从一开始就增加了 NATS 实例的内存占用；每次新增服务或 Stream 都需要手动更新配置文件；对低配机器的本地开发不友好。
- **原因：** 管理大型静态配置的开销超过了本项目目标受众所能获得的收益。

### 基础设施即代码 (Terraform/Ansible)

- **优点：** 高度专业、自动化且可重复的基础设施管理。
- **缺点：** 为开发者增加了额外的复杂性和依赖；显著增加了初始安装时间和资源消耗。
- **原因：** 对于一个专注于开发者易用性和低资源占用的项目来说过于沉重。

## 后果

- **资源效率：** NATS 实例以最小化占用启动，仅消耗活动服务绝对必需的资源。
- **开发者体验：** 简化了安装过程；开发者无需学习 NATS 配置语法或管理复杂文件即可开始开发。
- **代码所有权：** 服务管理自己的基础设施依赖，促进了更加解耦和自治的架构。
- **初始化检查：** 由于每个服务都需要验证其所需的 Stream，服务启动时间会略微增加。
- **幂等性：** NATS Stream 的创建是幂等的，因此多个服务实例可以安全地执行此检查而不会引发错误。
