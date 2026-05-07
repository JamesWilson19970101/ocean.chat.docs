1. IM_CORE（网关上行接入流）
   这个流是整个 IM 系统的入口，用于承接 WS Gateway 收到的大量原始客户端上行包。
   - 特性：超高吞吐，短保留期（例如 1-3 天）。
   - Subjects 设计：
     - im.up.p2p：单聊上行消息
     - im.up.group：群聊上行消息
     - im.up.signal.\*：信令上行（如撤回、正在输入等）
   - 流转：WS Gateway (Producer) -> im.up.> -> Router Service (Pull Consumer)

2. IM_HANDOFF（内部路由与 WAL 核心流）🌟
   这是系统最关键的流。它既是微服务之间的接力棒，也是系统的写屏障（WAL，预写日志）。

- 特性：高可靠，需要持久化到 SSD。
- Subjects 设计：
  - im.route.{p2p|group}：Router Service 解析完 Payload 后，投递给负责具体业务的 Message Service 或 Group Service。
  - im.orchestrate.msg：关键！这就是 Write Fence 所在的主题。Message Service 校验权限、生成 SeqId 后，将消息投递到此。NATS 一旦 ACK，就可以给客户端返回 MSG_UP_ACK。
- 流转：
  1.  Router Service -> im.route.\* -> Message Service
  2.  Message Service -> im.orchestrate.msg -> Orchestrator Service（用于派发推送）
  3.  Message Service -> im.orchestrate.msg -> MessagePersistence Worker（异步大批量 Pull 消费，负责落库 MongoDB）

3. IM_DOWNBOUND（网关定点下发流）
   用于将明确需要下发的消息，精准投递到目标用户所在的特定网关实例。

- 特性：易失性或极短保留期（网关宕机则丢弃，依赖客户端断线重连后的 SYNC_REQ 恢复）。
- Subjects 设计：
  - im.down.node.{gateway_node_uuid}：以网关节点的 UUID 为路由键。
- 流转：Orchestrator Service / Realtime Pusher -> im.down.node.\* -> WS Gateway

4. GROUP_HYBRID（超大群降级流）
   专门为了解决万人大群“写扩散”导致的扇出雪崩而设计。

- 特性：只存极小的数据包（Tick）。
- Subjects 设计：
  - group.tick.{group_id}：某个大群产生了新消息的信号。
- 流转：Orchestrator Service -> group.tick.\* -> 相关的 WS Gateway -> 在线客户端（客户端收到后比对 MaxSeqId，再决定是否发 HTTP 请求拉取内容）。

5. DEVICE_SYNC（设备状态同步流）
   用于多端登录时，一台设备清除了未读红点，其他设备要立刻响应。

- 特性：内存存储即可，极端情况丢失可接受（客户端下次拉取全量状态可恢复）。
- Subjects 设计：
  - sync.cursor.read.{user_id}：某用户已读了某会话。
- 流转：API Gateway / WS Gateway -> sync.cursor.read.\* -> WS Gateway（扇出给该用户其他在线的设备连接）。

6. SYS_PRESENCE（全局在线状态流）
   网关节点感知到 TCP 连接建立或断开时触发。

- 特性：极高频，保留期极短。
- Subjects 设计：
  - presence.conn.online
  - presence.conn.offline
- 流转：WS Gateway -> presence.conn.\* -> Presence Service（更新 Redis 在线状态图谱）。

7. OFFLINE_PUSH（离线推送工作流）
   当 Orchestrator 发现目标用户没有任何在线 TCP 连接时，转入此流。

- 特性：工作队列（WorkQueue）模式，消费成功即删除。
- Subjects 设计：
  - push.offline.apns：苹果推送
  - push.offline.fcm：谷歌推送
- 流转：Orchestrator Service -> push.offline.\* -> Offline Pusher Worker（慢慢调用第三方 API 防止被限流）。

8. BACKGROUND_TASKS（异步重负载流）
   处理耗时较长的非实时任务。

- 特性：工作队列（WorkQueue）模式，支持超时重试和显式 NAK（Negative Acknowledge）。
- Subjects 设计：
  - task.media.transcode：视频/音频转码
  - task.audit.content：涉黄/涉政文本过滤
- 流转：API Gateway / Message Service -> task.\* -> 对应的基础支撑服务。

# 业务逻辑

1. 消息发送与落库：用户发送单聊或群聊消息，系统进行权限校验、生成序号（SeqId）并异步写入数据库。
2. 在线消息下发：接收方在线时，系统精准定位其所在的网关节点，实时推送消息体。
3. 大群消息推拉：用户在万人大群发消息，系统仅下发轻量级的“新消息信号（Tick）”，客户端根据该信号按需拉取具体内容。
4. 离线通知推送：接收方 App 处于后台或未连接时，系统调用苹果（APNs）、安卓（FCM）等厂商通道发送通知。
5. 多端已读同步：用户在手机端已读了某条消息，电脑端实时接收到游标更新，消除未读红点。
6. 用户上下线管理：用户打开 App 建连或断网离线，系统实时感知并更新其全局在线状态图谱。
7. 鉴权与安全管控：用户登录、登出，或因在其他设备登录触发 Token 撤销（踢人下线）。
8. 多媒体与合规处理：用户发送图片、音视频，后台异步触发文件转码、生成缩略图以及敏感词/鉴黄审核。
9. 信令状态交互：用户执行“撤回消息”操作，或触发“正在输入中…”的临时状态展示。
