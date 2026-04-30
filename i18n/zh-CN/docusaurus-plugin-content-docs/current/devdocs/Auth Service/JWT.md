---
id: jwt-hybrid
title: "理解 JWT 混合模式"
sidebar_label: "JWT 混合模式"
description: "解释 Ocean Chat 的 JWT 混合策略，通过分离 Access Token 和 Refresh Token 来平衡性能与安全。"
keywords:
  [
    ocean chat,
    jwt,
    混合认证,
    access token,
    refresh token,
    安全,
    令牌,
    纵深防御,
    解释,
  ]
---

<head>
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:title" content="理解 JWT 混合模式 | Ocean Chat" />
  <meta property="og:description" content="解释 Ocean Chat 的 JWT 混合策略，通过分离 Access Token 和 Refresh Token 来平衡性能与安全。" />
  <link rel="canonical" href="https://jameswilson19970101.github.io/ocean.chat.docs/zh-CN/docs/devdocs/Auth%20Service/jwt-hybrid" />
</head>

# 理解 JWT 混合模式

JSON Web Token (JWT) 是一种作为 JSON 对象安全传输信息的流行标准。然而，单一且长期有效的 JWT 引入了深远的安全漏洞，特别是关于令牌窃取和会话撤销方面。

本文档解释了 Ocean Chat 的 **JWT 混合模式认证策略 (JWT Hybrid Mode Authentication Strategy)**。该方法通过将授权拆分为两个截然不同的令牌生命周期来实现纵深防御：高性能的 **Access Token (访问令牌)** 和高安全性的 **Refresh Token (刷新令牌)**。

## 上下文：单一令牌的脆弱性

如果应用程序颁发一个有效期为 30 天的单一 JWT，用户很少需要重新登录。但是，如果该令牌通过跨站脚本 (XSS) 或网络嗅探被拦截，攻击者将拥有长达一个月的无限制访问权限。在没有有状态基础设施的情况下，撤销那个特定的令牌极其困难。

为了防止这种情况，必须大幅缩短令牌的生命周期。但是短期的令牌（例如 15 分钟）会迫使持续重新认证，破坏用户体验。混合模式解决了这一悖论。

## 核心概念：授权关注点分离

混合模式将会话生命周期划分为两个专门的角色，以满足 99% 的日常流量与 1% 的会话续期之间相互冲突的需求。

### Access Token (AT)

Access Token 是日常 API 交互的“通行证”。

- **生命周期：** 极短（5 到 15 分钟）。
- **验证机制：** 完全无状态。由 API 网关使用 [零 I/O 密码学](./understanding-zero-io-authentication.md) 在本地进行验证。
- **存储策略：** 专门存储在客户端的 **JavaScript 内存变量** 中。
- **基本原理：** 存储在内存中可防止 CSRF 攻击（因为浏览器不会自动附加它），并消除 XSS 风险（无法从 `localStorage` 中读取它）。如果页面重新加载，内存即被清除，将攻击窗口最小化到仅仅几分钟。

### Refresh Token (RT)

Refresh Token 是仅用于获取新 Access Token 的“会话密钥”。

- **生命周期：** 长期（7 到 30 天）。
- **验证机制：** 有状态的。必须根据数据库检查它是否已被撤销或替换。
- **存储策略：** 存储在安全的 **`HttpOnly` Cookie** 中。
- **基本原理：** `HttpOnly` 完全阻断了 JavaScript 的访问，使 RT 免受 XSS 攻击。通过将其绑定到 Cookie，当需要新的 Access Token 时，浏览器会自动且无缝地将其发送到 `/auth/refresh` 接口。

:::danger 密钥隔离
Access Token 和 Refresh Token 必须使用完全不同的加密密钥 (`JWT_ACCESS_SECRET` vs `JWT_REFRESH_SECRET`) 进行签名，以确保一个令牌不能从另一个令牌中推导出来。
:::

## 替代方案与权衡

在设计客户端存储时，有多种替代方案：

- **Local Storage：** 在页面重新加载和新标签页中得以保留，提供无缝的用户体验。然而，它直接暴露于 XSS 之下。如果攻击者注入脚本，他们会立即窃取长期凭证。
- **Session Storage：** 在同一标签页内的重新加载中得以保留，但仍然容易受到 XSS 攻击。
- **内存 + HttpOnly Cookie (我的方法)：** 最安全的方法。主要的权衡是对用户体验的轻微影响：打开新标签页或刷新页面会清除内存中的 Access Token。客户端必须自动透明地调用刷新接口，在继续之前获取新的 AT。

### Refresh Token 轮换 (Token Rotation)

为了进一步确保 Refresh Token 的安全，Ocean Chat 采用了 **令牌轮换 (Token Rotation)** 机制。

每次客户端使用 RT 获取新的 AT 时，服务器都会在下发新 AT 的同时颁发一个 **全新的 RT**，并在数据库中立即使旧的 RT 失效。如果攻击者以某种方式窃取了 RT，并在合法用户已经轮换了它之后试图使用它，服务器就会检测到 **重放攻击 (Replay Attack)**。它将立即立即使整个会话家族失效，迫使用户重新登录。

## 高层次视角

JWT 混合策略本质上是关于风险控制。通过认识到前端环境天生具有敌意（由于浏览器扩展、第三方脚本和 XSS 风险），该架构将任何成功入侵的爆炸半径最小化。被盗的 Access Token 在造成实质性损害之前就会过期，而高度安全、轮换的 Refresh Token 则安全地管理着用户的持久信任。
