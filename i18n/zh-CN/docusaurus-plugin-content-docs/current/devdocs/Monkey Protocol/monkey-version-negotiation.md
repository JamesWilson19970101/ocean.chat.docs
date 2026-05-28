---
id: monkey-version-negotiation
title: 握手阶段的平滑“版本协商”机制
description: 详细规范 Monkey Protocol 在长连接握手阶段如何通过版本协商实现客户端的平滑降级与强制升级。
keywords:
  [
    ocean chat,
    monkey protocol,
    版本协商,
    version negotiation,
    websocket,
    容错机制,
  ]
sidebar_position: 3
tags: ["ocean-chat", "specification", "architecture", "websocket"]
---

# 握手阶段的平滑“版本协商”机制

在 C 端即时通讯（IM）应用中，客户端（App/PC/Web）的发版往往存在严重的**碎片化**。当服务端需要对底层 Monkey Protocol 进行迭代（例如从 `v1` 升级到 `v2` 增加压缩算法或修改帧结构）时，如果网关采用“不匹配就强制断开 (Hard Reject)”的策略，会导致旧版客户端陷入无限重连的死循环，既损害了用户体验，又会引发网关的连接风暴。

为此，Monkey Protocol 在连接握手（Handshake）阶段引入了**平滑的版本协商 (Smooth Version Negotiation)** 机制。本文档详细规定了双端的协议交互流程与客户端 SDK 的状态机实现。

---

## 1. 核心设计思想

1. **握手即协商**：利用现有的 `[0x01] AUTH_REQ` 建立连接认证的过程，顺带完成协议版本的握手。
2. **兼容性探针**：客户端在请求中主动上报自己支持的**版本区间**。
3. **优雅拒绝与指引**：如果服务端不支持客户端当前的首选版本，服务端**不直接断开 TCP 连接**，而是下发携带特定错误码的 `[0x0C] EXCEPTION_ACK`，并指明服务端目前支持的版本。
4. **客户端静默路由**：客户端 SDK 底层拦截到版本错误的异常后，自动进行“降级/升级重连”或触发“强制更新 UI”，对上层业务完全透明。

---

## 2. 协议结构扩展

为了支持版本协商，我需要在握手阶段相关的 Protobuf 载荷（Payload）中增加版本字段。

### 2.1 客户端上行：`AUTH_REQ` 载荷扩展

在客户端发送 `[0x01] AUTH_REQ` 时，除了常规的 JWT Token 和设备信息，还需要上报客户端所支持的协议版本列表。
_注：Monkey Protocol 12 字节 Header 的第 2 字节 (`Version`) 代表的是**当前帧首选的通信版本**。_

```protobuf
message AuthReq {
  string token = 1;
  string device_id = 2;
  int32 device_type = 3;

  // 新增：客户端底层 SDK 支持的所有 Monkey Protocol 版本号列表
  // 示例：[1, 2] 表示同时支持 v1 和 v2
  repeated uint32 supported_versions = 4;
}
```

### 2.2 服务端下行：`EXCEPTION_ACK` 载荷扩展

如果网关拒绝了首选版本，会下发 `[0x0C] EXCEPTION_ACK`。我为其定义一个专属的错误码 `426`（Upgrade Required / Protocol Mismatch），并在 Payload 中明确服务端支持的版本。

```protobuf
message ExceptionAck {
  int32 error_code = 1; // 协议不匹配时，固定为 426
  string message = 2;   // 错误描述，如 "Protocol version mismatch"

  // 新增：服务端网关当前支持的 Monkey Protocol 版本号列表
  // 示例：[2, 3] 表示网关目前仅支持 v2 和 v3
  repeated uint32 server_supported_versions = 3;
}
```

---

## 3. 协商交互流程 (State Machine)

### 场景 A：首选版本匹配（完美路径）

1. 客户端 SDK 将 Header 中的 `Version` 置为自己最优的版本（如 `0x02`）。
2. 客户端发送 `[0x01] AUTH_REQ`，Payload 中 `supported_versions = [1, 2]`。
3. `oceanchat-ws-gateway` 检查 Header 的 `Version` 为 `0x02`，且自身支持该版本。
4. 网关调用 `oceanchat-auth` 鉴权成功，下发 `[0x02] AUTH_ACK`。
5. **结果**：协商成功，后续所有通信采用 `v2`。

### 场景 B：服务端触发平滑降级 (Smooth Downgrade)

假设客户端刚更新，支持 `[1, 2]`，首选 `0x02`。但网关集群还没滚动更新完，当前网关 Pod 仅支持 `[1]`。

1. 客户端发送 Header `Version: 0x02`，Payload `supported_versions: [1, 2]`。
2. 网关发现不认识 `0x02`，但底层 12 字节魔数 `0x4D4B` 是合法的，于是网关**主动拒绝**。
3. 网关下发 `[0x0C] EXCEPTION_ACK` (error_code: 426, server_supported_versions: [1])。
4. **客户端 SDK 拦截逻辑**：
   - 收到 426 错误码。
   - 取两个数组的交集：`Client[1, 2] ∩ Server[1] = [1]`。
   - 交集不为空！客户端 SDK 自动在底层将当前配置的 Header `Version` 降级为 `0x01`。
   - 客户端 SDK **静默断开当前 Socket，立即发起重连**（不通知 UI 层）。
5. **结果**：重连后以 `v1` 握手成功，用户无感知。

### 场景 C：严重不匹配导致强制升级 (Force App Update)

假设客户端太老，仅支持 `[1]`。服务端进行了大重构，彻底废弃了 `v1`，网关仅支持 `[2, 3]`。

1. 客户端发送 Header `Version: 0x01`，Payload `supported_versions: [1]`。
2. 网关不再支持 `v1`，下发 `[0x0C] EXCEPTION_ACK` (error_code: 426, server_supported_versions: [2, 3])。
3. **客户端 SDK 拦截逻辑**：
   - 收到 426 错误码。
   - 取交集：`Client[1] ∩ Server[2, 3] = Ø` (空集)。
   - 交集为空！说明当前 App 版本已经绝对无法与服务器通信。
   - 客户端 SDK **不再发起任何重连尝试**，直接断开网络。
   - 客户端 SDK 向上层 UI 抛出严重致命错误事件（如 `EVENT_FORCE_UPDATE_REQUIRED`）。
4. **结果**：App 弹出“当前版本过低，请前往应用商店更新”的强制阻断弹窗。

---

## 4. 服务端网关实现规范 (`oceanchat-ws-gateway`)

为了保证十万级并发下的性能，版本检查必须在**最高优先级（前置拦截器）**执行：

1. **零 I/O 拦截**：如果网关检测到 Header 上的 `Version` 字节不被支持，**不应该**再发起任何 RPC 去调用 `oceanchat-auth` 进行 JWT 鉴权。网关可以直接组装 426 的 `EXCEPTION_ACK` 踢回给客户端并断开连接。这能有效防御旧版客户端发起的“鉴权风暴”。
2. **版本配置下发**：网关的 `server_supported_versions` 应当从环境变量或配置中心读取，方便运维在滚动升级期间进行灰度控制。

```typescript
// 网关极简拦截伪代码
if (!SUPPORTED_VERSIONS.includes(header.version)) {
  const exceptionAck = encodeExceptionAck({
    errorCode: 426,
    message: "Protocol version mismatch",
    serverSupportedVersions: SUPPORTED_VERSIONS,
  });
  client.send(exceptionAck);
  // 延迟 100ms 后断开，确保客户端能收到异常包
  setTimeout(() => client.terminate(), 100);
  return; // 终止后续的 AUTH 鉴权与业务转发
}
```

---

## 5. 总结

通过引入 426 状态码和双向支持列表匹配：

1. **极大提升 C 端体验**：协议的非兼容性升级不再意味着旧版用户的断崖式崩溃。服务端可以在较长的一段时间内同时支持 `[v1, v2]`，让客户端在新老网关节点间自由穿梭。
2. **解放服务端运维**：运维进行服务端底层网络组件更新时，再也不用担心旧版客户端因为持续报错而引发疯狂的 DDoS 级别自动重连。
3. **完善的生命周期防线**：配合 `EXCEPTION_ACK`，使得 Monkey Protocol 在建立起真正的聊天数据流之前，就建立起了一道坚固的柔性协商屏障。
