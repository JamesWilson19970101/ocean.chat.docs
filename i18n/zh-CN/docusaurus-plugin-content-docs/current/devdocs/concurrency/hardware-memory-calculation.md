---
id: hardware-memory-calculation
title: 硬件内存与集群测算指南
description: 详细指导如何针对 100,000 个并发 WebSocket 连接，在标准的 8核4G 机器环境下进行硬件内存与集群规模测算。
keywords: [ocean chat, 硬件, 内存, 并发, 集群测算, ddr4, ddr5, 十万并发]
tags: ["ocean-chat", "guide", "tutorial", "developer-docs"]
image: https://docs.oceanchat.com/img/social-card.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

> 参考文章
>
> - [js对象占用内存](https://zhuanlan.zhihu.com/p/431625839)

// TODO: 本文目前仅从理论层面对内存进行估算，生产环境上线之前需要使用分布式检测工具，测试n个并发的情况下每个微服务的内存使用情况（promethussdk grafanapannel opentelemetrysdk）。本文给出的理论测试仅用于估算大概需要的设备。代码原理如下：

```javascript
// 真实环境中的 connection
import { TokenBucket } from '@ocean.chat/cores';
import { MonkeyCmd, MonkeyService, MsgNotify } from '@ocean.chat/monkey';
import { ConnectionAuthStatus } from '@ocean.chat/types';
import { WebSocket } from 'ws';

/**
 * Represents a single client connection in the gateway.
 * Strictly stateless regarding business logic, only maintains connection-level metadata.
 */
export class ClientConnection {
  // TODO: Add `connectionId` (e.g., UUID) to represent the physical network connection.
  // Why it is needed:
  // 1. Prevent Socket Race Conditions: Differentiate new connections from "ghost" connections during rapid reconnects.
  // 2. Pre-Auth Tracking: Identify and trace sockets before they successfully authenticate and acquire a userId/deviceId.
  // 3. Strict Targeted Responses: Allow backend routing to target or abort specific physical channels rather than the whole device.
  // 4. End-to-End Observability: Provide a unique trace ID for logs from TCP handshake to disconnection.
  public userId?: string;
  public deviceId?: string;
  public deviceType?: string;
  public jti?: string;
  public exp?: number;
  public authStatus: ConnectionAuthStatus = ConnectionAuthStatus.PENDING;
  public readonly connectedAt: number = Date.now();
  public lastActiveTime: number = Date.now();
  public pingSent: boolean = false;

  // Rate limiter: 20 tokens capacity, 20 tokens refill per second (default)
  public readonly rateLimiter: TokenBucket = new TokenBucket(20, 20);

  // Micro-batching for MSG_NOTIFY: Map<GroupId, MaxSyncSeqId>
  private readonly notifyCollapseMap = new Map<string, string>();

  private static readonly dirtyConnections = new Set<ClientConnection>();
  private static globalCollapseTimer?: NodeJS.Timeout; // Use a single global timeout. Creating a timer per user consumes underlying C++ resources and can lead to memory exhaustion under high concurrency.

  constructor(
    public readonly ws: WebSocket,
    private readonly monkeyService: MonkeyService,
  ) {}

  /**
   * Refreshes the last active time (`lastActiveTime`) of the current connection.
   *
   * This method implements the **"Any Message is Pong"** strategy defined in the Monkey Protocol.
   * Whenever the gateway receives any valid upstream data packet from the client
   * (whether it is a simple `PING` or an actual business payload like `MSG_UP`),
   * this method is called to update the activity timestamp. This prevents the connection
   * from being mistakenly identified as a zombie connection and forcefully terminated
   * by the gateway's periodic cleanup task (`sweepZombies`).
   */
  public refreshActivity(): void {
    this.lastActiveTime = Date.now();
    this.pingSent = false;
  }

  /**
   * Cleans up all pending timers to prevent memory leaks.
   */
  public cleanup(): void {
    ClientConnection.dirtyConnections.delete(this);
    this.notifyCollapseMap.clear();
  }

  /**
   * Marks the connection as authenticated.
   */
  public authenticate(
    userId: string,
    deviceId: string,
    jti: string,
    exp: number,
    deviceType?: string,
  ): void {
    this.userId = userId;
    this.deviceId = deviceId;
    this.jti = jti;
    this.exp = exp;
    this.deviceType = deviceType;
    this.authStatus = ConnectionAuthStatus.AUTHENTICATED;
  }

  /**
   * Enqueues a notification for micro-batching.
   * Collapses multiple notifications for the same group within a 200ms window.
   */
  public enqueueNotify(groupId: string, syncSeqId: string): void {
    const currentMax = this.notifyCollapseMap.get(groupId);

    // Only keep the largest SeqId (Notification Collapse)
    if (!currentMax || BigInt(syncSeqId) > BigInt(currentMax)) {
      this.notifyCollapseMap.set(groupId, syncSeqId);
    }

    // Add this connection to the global batching train
    ClientConnection.dirtyConnections.add(this);

    // If the train hasn't started the countdown, start it
    if (!ClientConnection.globalCollapseTimer) {
      ClientConnection.globalCollapseTimer = setTimeout(() => {
        ClientConnection.flushAllDirtyConnections();
      }, 200);
    }
  }

  /**
   * Flushes all connections that have pending notifications in a single tick.
   */
  private static flushAllDirtyConnections(): void {
    ClientConnection.globalCollapseTimer = undefined;
    for (const conn of ClientConnection.dirtyConnections) {
      conn.flushNotifies();
    }
    ClientConnection.dirtyConnections.clear();
  }

  /**
   * Flushes all collapsed notifications to the client.
   */
  private flushNotifies(): void {
    for (const [groupId, syncSeqId] of this.notifyCollapseMap.entries()) {
      const payload = Buffer.from(
        MsgNotify.encode({ groupId, syncSeqId }).finish(),
      );
      // ReqId 0 is used for server-initiated pushes (non-RPC)
      const buffer = this.monkeyService.frame(
        { cmd: MonkeyCmd.MSG_NOTIFY, reqId: 0, flags: 0 },
        payload,
      );

      this.sendRaw(buffer);
    }

    this.notifyCollapseMap.clear();
  }

  /**
   * Directly sends a pre-framed buffer to the client.
   */
  public sendRaw(buffer: Buffer): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(buffer, { binary: true });
    }
  }
}

```

```javascript
// 计算内存占用
const initialMemory = process.memoryUsage().heapUsed;

const connections = [];
const COUNT = 100_000; // 创建 10 万个纯粹的对象

for (let i = 0; i < COUNT; i++) {
  // 模拟一个包含几个基本字段的类实例
  connections.push(new Connection(params));
}

// 记录结束内存
const finalMemory = process.memoryUsage().heapUsed;
const diffBytes = finalMemory - initialMemory;

console.log(`10万个对象总共占用: ${(diffBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`平均每个对象占用: ${(diffBytes / COUNT).toFixed(2)} Bytes`);
```

// TODO: 将测试逻辑转移到 `@ocean-chat/hardware-memory-calculation` 模块中。主要依据下面的思路给用户提出部署建议，最后得出的是一个表格，描述不同并发层级下（10000，30000，50000，100000）的硬件（每个微服务需要部署几台机器，基础组件需要部署几台机器）建议。

# 硬件内存与集群测算指南：支撑十万并发

本指南将一步步计算并推演支撑 **100,000 并发 WebSocket 连接** 的 Ocean Chat 集群到底需要多少内存和硬件资源。

测算将针对常见的 **8核 CPU / 4GB 内存** 机器进行。如何规划集群规模、评估 DDR4 与 DDR5 内存的选择，并识别高并发 IM 系统中真实的性能瓶颈。

:::tip 问题导向
这是一篇 **How-to Guide (操作指南)**。它假定读者已经了解 Ocean Chat 的架构，现在需要将其需求转化为物理硬件部署方案。
:::

## 第一步：测算微服务本身占用的内存

IM 系统中最消耗内存的部分是维持活跃的 TCP/WebSocket 长连接。虽然 `oceanchat-ws-gateway` 在业务逻辑上是**无状态**的，但它在物理层面上持有海量的 Socket 句柄，是集群中唯一需要维护“底层连接状态”的边缘节点。

### WebSocket 的底层数学

在 Node.js 环境下，维持一个空闲的 WebSocket 连接（包含底层的 TCP 缓冲区以及 V8 引擎的对象开销），大约需要消耗 **nKB** 的物理内存。

- **100,000 个连接 × n KB = n × 100,000 KB ≈ n/10 GB** _(采用 1GB ≈ 1,000,000 KB 的工程近似估算，此宽估能在计算中天然提供约 4.8% 的安全冗余)_

### 8核4G 机器的窘境

如果 10 万个连接光是 Socket 句柄就需要整整 n/10 内存，单台 4GB 的机器一定会立刻因为内存溢出 (OOM) 而崩溃。
此外，**8核 / 4GB** 是一个严重的内存瓶颈配比。开启 Node.js Cluster 模式（8 个 Worker 进程）意味着：

- 4GB 总内存 / 8 个 Worker = **每个进程仅分到 ~500MB 内存**。
- 如果让一台机器扛 10 万连接，每个 Worker 要处理 12,500 个连接（塞满 500MB）。一旦 V8 引擎触发垃圾回收 (GC)，极易导致 OOM。

为了在 4GB 机器上安全承载 10 万连接，必须分散负载，计划将内存利用率控制在 60% 以下。

- **单台机器可用内存上限**：`4 GB × 60% = 2.4 GB`
- **机器数量计算公式**：`(n/10) GB ÷ 2.4 GB = n/24` 台

**实战举例**：
假设经过实际压测，Node.js 中单个空闲长连接的内存占用为 **40 KB** (即 `n = 40`)：

- 集群总内存需求：`40 / 10 = 4 GB`
- 理论所需机器数量：`40 / 24 ≈ 1.67`，向上取整需要 **2 台**。为了容灾高可用，通常配置 **3 台**（每台承载约 3.3 万连接，消耗约 1.3GB 内存）。

> 注意：生产和开发环境中的框架本身所占用的内存，以及框架中其他单例对象所占用的内存。

// TODO: 使用上述方法计算内存后，管理员的审计面板需要根据上述计算模式给出部署的硬件建议。

## 第二步：测算 Redis 状态缓存内存

`oceanchat-presence` 依赖 Redis 存储全局路由图谱。

### 单用户内存足迹

我使用 Redis Hash (`user:routing:{userId}`) 存储一段包含 `gatewayId` 和设备元数据的 JSON。

- 单个在线用户占用：约 n Bytes。
- **100,000 在线用户 × n Bytes = n × 100,000 Bytes ≈ n/10 MB** _(同上采用工程近似估算)_。

### 群组消息滑动窗口 (ZSET) 内存足迹

为了支持离线推送的未读数精确计算，我在 Redis 中为每个活跃群组保留了最近 100 条消息的 ID（使用 ZSET 存储）。

- 目前假设单条 ZSET 记录占用（包含 Double Score 和 消息 ID 字符串）：约 30 Bytes。
- 单个群组占用：`100 条 × 30 Bytes ≈ 3 KB`。
- **10,000 个活跃群组 × 3 KB ≈ 30 MB**。

**实战举例**：
假设经过实际测量，单个在线用户的状态元数据占用为 **150 Bytes**（即 `n = 150`）：

- 基础路由状态总内存需求：`150 / 10 = 15 MB`。

即便在这个基础上算上 Redis 的内部字典开销，以及上述的群组 ZSET（10,000 个活跃群约消耗 30 MB），在十万并发下，Redis 总物理内存消耗通常也极少超过 **200 MB**。

> // TODO: 一个一个捋一下哪些逻辑用了redis，详细计算出来。

**根据上面的假设得出的测算结论：**
对于十万并发的内存状态而言，一台 4GB 的机器属于**性能严重过剩**。

- **所需机器数量：** **1 台**（若需高可用，可部署 3 台组成 Sentinel 哨兵集群）。

// TODO: 其中有一个比较占用内存的逻辑，我在代码中为每个群保留了最近的100条消息在redis中，所以这里还需要完善文档。
// TODO: 使用上述方法计算内存后，管理员的审计面板需要根据上述计算模式给出部署的硬件建议。

### 实战：如何查看真实的 Redis 内存占用？

在生产或测试环境中，可以直接使用命令行工具 `redis-cli` 来验证上述的理论计算：

1. **查看全局内存概况**：
   登录 Redis 服务器并使用 `INFO memory` 命令。主要关注 `used_memory_human`（Redis 分配的真实数据内存）和 `used_memory_rss_human`（操作系统为 Redis 分配的物理总内存）。
   ```bash
   redis-cli INFO memory
   ```
2. **精确查看单个用户的状态内存**：
   为了获取前面计算公式中准确的 **n** 值（即单个在线用户占用的实际字节数，建议测量 3 次取平均值），可以使用 `MEMORY USAGE` 命令精确查看特定 Key 的内存消耗（返回结果单位为字节）：
   ```bash
   redis-cli MEMORY USAGE user:routing:{userId}
   ```
3. **排查内存消耗大户**：
   如果运行期间发现 Redis 内存异常飙升，可以使用 `--bigkeys` 参数扫描并找出最占空间的大对象，这对于排查群组 ZSET 膨胀非常有用：
   ```bash
   redis-cli --bigkeys
   ```

## 第三步：测算消息队列内存

### NATS JetStream (消息队列)

NATS 由 Go 编写，内存管理极其高效。由于 Ocean Chat 核心的 WAL 预写日志（如 `IM_CORE`）使用 `StorageType.File`，这部分主要依赖磁盘 I/O 和系统页缓存 (OS Page Cache)。但系统为了极致低延迟，部分高频信令（如 `CURSOR_STATE` 和 `IM_DOWNBOUND`）使用了 `StorageType.Memory`。

#### 内存流消息足迹

在内存流中折叠（如 `max_msgs_per_subject: 1`）或短暂保留极轻量的信令消息。

- 单条驻留内存的消息占用：约 n Bytes。
- **100,000 条驻留消息 × n Bytes = n × 100,000 Bytes ≈ n/10 MB**。

**实战举例**：
假设经过实际测量，单条内存流消息（包含 Payload 与 NATS 内部元数据）占用为 **200 Bytes**（即 `n = 200`）：

- 内存流总内存需求：`200 / 10 = 20 MB`。

// TODO: 其中有比较占用内存的逻辑，我将消息在nats jetstream中保留了7天为工程师留出足够的时间修复bug。这个需要通过监 n 天后取平均七天的值。

#### 实战：如何查看真实的 NATS 内存占用？

可以通过 NATS 提供的自带 CLI 工具或 HTTP 监控端口来验证理论计算：

1. **查看服务器全局资源**：
   使用 NATS CLI 检查服务器的当前 CPU 和内存真实使用量。
   ```bash
   nats server info
   ```
2. **精确查看特定内存流的占用**：
   为了获取上述的真实 **n** 值与总量，可以查看某个 `StorageType.Memory` 流（例如 `CURSOR_STATE`）的具体统计数据（包含 State 中的 Bytes）：
   ```bash
   nats stream info CURSOR_STATE
   ```
3. **使用 HTTP 监控端点排查**：
   开启监控端口（默认 8222），可以直接获取系统级 JSON 格式详细指标（关注 `mem` 字段，单位为字节）：
   ```bash
   curl http://localhost:8222/varz
   ```

## 第四步：测算 MongoDB 内存与硬盘使用

MongoDB 作为 Ocean Chat 的最终持久化存储，其资源消耗主要体现在**磁盘空间 (Storage)**、**磁盘 IOPS** 以及 **WiredTiger 缓存 (Memory)** 上。

### 1. 存储容量测算 (Disk Storage)

由于 Ocean Chat 采用写后持久化，每一条被成功路由的业务消息最终都会作为一条 BSON Document 落盘。

- 单条消息文档（包含 `_id`, `SyncSeqId`, `ClientMsgId` 及 Payload 等元数据）：约 n Bytes。
- **每日新增存储量： 每日总消息量 M 万条 × n Bytes ≈ (M × n / 1,000) MB**。

**实战举例**：
假设单条消息文档大小为 **500 Bytes** (即 `n = 500`)，十万日活系统每天产生 **1000 万条** 消息 (`M = 1000`)：

- 每日新增逻辑容量：`1000 × 500 / 1000 = 500 MB`。
- 每年新增容量：`500 MB × 365 ≈ 180 GB`。（注意：实际 WiredTiger 默认开启 Snappy 或 Zstandard 块压缩，聊天文本通常有 50% 左右的压缩率，物理占用通常减半约 90 GB）。

### 2. IOPS 与内存测算 (BulkWrite & Memory)

在传统 IM 中，每秒 10,000 条消息并发意味着瞬间 10,000 次随机写，这会瞬间击穿数据库。但在 Ocean Chat 中，后台 `MessagePersistence Worker` 通过批量拉取执行 `bulkWrite`：

- 假设 `batchSize = 1000`，10,000 条消息/秒的并发洪峰，在 MongoDB 层面仅表现为极其平缓的 **10 次 IOPS**！
- **内存消耗**：MongoDB 强烈依赖内部的 WiredTiger Cache（默认占用 `(RAM - 1GB) * 50%`）和 OS Page Cache。对于 10 万并发，只要内存能够装下**热点索引**（如 `groupId_seqId` 联合索引），即便物理内存不大，也不会出现慢查询。

**根据上面的假设得出的测算结论：**
得益于彻底的异步 `bulkWrite` 批处理机制，MongoDB 在 Ocean Chat 架构中不再是写入 IO 瓶颈。

- **所需机器数量：** **3 台**（构建 1主 2从 的 Replica Set 副本集），配置普通 NVMe SSD 即可，4GB 内存（其中约 1.5GB 作为 WT Cache）足以支撑十万级热点数据的索引缓冲。

### 实战：如何查看真实的 MongoDB 占用？

在生产或测试环境中，可以直接使用 `mongosh` 和监控工具来获取公式中需要的常量：

1. **精确测算单条消息文档的 n 值**：
   在 `mongosh` 中执行集合统计，关注 `avgObjSize` 字段，它代表了单条消息在内存中的平均字节数 (即 n 值)：
   ```javascript
   db.messages.stats();
   ```
2. **查看数据库级的存储大小与压缩率**：
   执行 `db.stats()`，重点关注 `dataSize` (未压缩的真实逻辑数据量) 和 `storageSize` (经过 WiredTiger 压缩后在磁盘上的物理占用)。
3. **实时监控 IOPS 和内存命中率**：
   在服务器终端直接运行 `mongostat`，它类似于 Linux 的 `top` 命令，非常适合压测时观测：
   ```bash
   mongostat --rowcount 20 1
   ```
   _(重点关注 `insert` 每秒插入批次数、`dirty` WT 脏数据比例 和 `res` 常驻物理内存大小)_

## 第五步：核心业务微服务测算

这些服务（如 `oceanchat-auth`, `oceanchat-message`, `oceanchat-router`）是典型的 **CPU 密集型** 节点，而非内存密集型。
**8 个核心** 在这里是绝对主角。RS256 验签、Protobuf 解码以及并发业务校验都极度依赖 CPU 算力。

> 这里需要使用并发请求多轮测试 CPU 负载。取平均值。

## 第六步：DDR4 vs. DDR5 内存世代决断

是否有必要为十万并发的 IM 系统购买昂贵的 DDR5 内存？

<Tabs>
  <TabItem value="ddr4" label="DDR4 (理论3200 MT/s)" default>
    **结论：完全胜任。**
    100k 用户每 10 秒发一条 1KB 消息，峰值吞吐仅约 10MB/s。而标准的 DDR4-3200 单通道理论带宽就高达 **25.6 GB/s** (`3200 MT/s × 64 bit ÷ 8`)，应对这点流量绰绰有余。此外，DDR4 通常具有更低的 CAS 延迟时序 (如 CL16)，这对 Redis 处理海量碎片化小包的随机查询反而更有利。
  </TabItem>
  <TabItem value="ddr5" label="DDR5 (理论4800+ MT/s)">
    **结论：边际效用递减的奢侈品。**
    DDR5 为 AI 训练或视频渲染提供了恐怖的带宽。但 IM 系统不需要搬运海量连续内存块。应该把这部分预算省下来，去购买性能更好的 NVMe 固态硬盘 (SSD)。
  </TabItem>
</Tabs>

:::warning SSD 远比内存重要
对于 IM 平台，**磁盘 I/O (NVMe SSD)** 的重要性远超 DDR5。NATS WAL 和 MongoDB 的批量写入性能完全取决于磁盘 IOPS。
:::
