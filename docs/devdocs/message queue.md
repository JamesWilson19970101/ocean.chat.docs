# Message Queue

This article mainly compares three message queue middlewares (RocketMQ vs Kafka vs NATS) and explains why NATS was chosen as the middleware for Ocean Chat.

## Core Architecture and Design Philosophy

- Apache RocketMQ
    - Design Philosophy: Born from Alibaba's e-commerce business, emphasizing "absolute no loss" of messages and complex business processing capabilities. It is more like a fully functional business system component than a simple data pipeline.
    - Communication Model: Uses Topic + Queue mode. Consumers subscribe to Topics, effectively pulling data from Queues. Supports Tag secondary filtering, suitable for business isolation.
    - Architecture Dependencies: Relies on NameServer for service discovery. Although NameServer is lighter and more decentralized than Zookeeper, it still requires independent deployment and maintenance, increasing the number of operation components.
    - Tech Stack: Pure Java implementation, mature ecosystem but heavy runtime.
- Apache Kafka
    - Design Philosophy: Designed originally to handle massive logs and stream data. It is essentially a distributed, partitionable, replicated commit log service (Commit Log), with the core goal of extreme throughput.
    - Communication Model: Uses Topic + Partition mode. Strict partition ordering, consumer groups bound to partitions.
    - Architecture Dependencies: Long-term reliance on Zookeeper for metadata management (although the new KRaft mode removes ZK, configuration parameters remain extremely complex and tuning is difficult).
    - Tech Stack: Written in a mix of Scala and Java, heavily reliant on the operating system's PageCache.
- NATS (Core & JetStream)
    - Design Philosophy: Advocates minimalism. Core NATS handles high-speed instant messaging (Fire-and-forget), while JetStream handles persistent stream processing. Its goal is to become the "central nervous system" of the cloud-native era.
    - Communication Model: Uses Subject-based addressing. Not limited to fixed Topics, but supports dynamic `.` hierarchical structures and wildcards (`*`, `>`), which is much more flexible than the traditional Topic/Queue model.
    - Architecture Dependencies: Zero dependencies. It is a statically compiled Go language binary file (Single Binary) with a built-in Raft consensus algorithm, capable of forming a full mesh cluster without any external components.
    - Tech Stack: Written in Go, cloud-native friendly.

## Features

- Apache RocketMQ
    - Message Types: Natively supports transactional messages (distributed transaction tool), delayed messages (scheduled tasks), ordered messages, dead letter queues, and retry queues.
    - Filtering Capabilities: Supports Tag filtering and SQL 92 standard attribute filtering, allowing filtering of unwanted messages on the server side to reduce network bandwidth pressure.
    - Interaction Mode: Although it supports Request-Reply, it is essentially simulated based on asynchronous messages and the implementation is heavy.
- Apache Kafka
    - Message Types: Functionality is relatively basic, mainly relying on its powerful stream processing ecosystem (Kafka Streams, KSQL). Does not support native arbitrary time delayed messages.
    - Interaction Mode: Only supports asynchronous decoupling. Completely unsuitable for synchronous RPC call scenarios.
    - Filtering Capabilities: Weak, usually requiring consumers to pull all data locally before filtering.
- NATS
    - Message Types: JetStream supports message deduplication and persistent streams. Although there are no native "transactional messages", it supports Headers and delayed publishing.
    - Interaction Mode: Natively supports Request-Reply. This is a killer feature of NATS, enabling it to directly replace HTTP/gRPC for synchronous calls within microservices with extremely high performance.
    - Unique Features: Built-in KV Store (distributed key-value storage) and Object Store, supports multi-tenant (Accounts) isolation, supports WebSocket.

## Performance

- Apache RocketMQ
    - Throughput: High (100k+ TPS). Although not as high as Kafka's extreme throughput, it is sufficient to support large-scale e-commerce concurrency.
    - Latency: Low and stable (ms level). Optimized for online business, latency fluctuations are small even with message accumulation, avoiding the obvious long-tail latency seen in Kafka.
    - Resource Consumption: High. As a Java application, heap memory overhead is large, and garbage collection (GC) may cause momentary performance "glitches".
- Apache Kafka
    - Throughput: Extremely high (million-level TPS). Achieves amazing write performance through sequential disk read/write and Zero Copy technology, very suitable for log collection.
    - Latency: Medium (ms ~ tens of ms). To pursue high throughput, Kafka defaults to a micro-batching mechanism, resulting in lower real-time performance for single messages compared to NATS and RocketMQ.
    - Resource Consumption: High. Requires a large amount of memory for PageCache to cache log segments, and has high disk I/O usage.
- NATS
    - Throughput: Extremely high. Core NATS can reach ten million-level TPS; JetStream's throughput in persistent mode is close to Kafka, but with higher CPU efficiency.
    - Latency: Extremely low (μs ~ ms level). Due to the extremely short code path and no JVM burden, NATS provides almost the lowest end-to-end latency on the market, very suitable for high-frequency trading and IoT control instructions.
    - Resource Consumption: Extremely low. Docker image is only ~15MB, startup requires only a few MB of memory, greatly saving cloud server costs.

## Why Choose NATS?

- Lightweight
    - Burden of RocketMQ/Kafka: RocketMQ and Kafka are both "heavy" middlewares based on JVM. Operating them requires understanding JVM tuning (heap size, GC strategy), deploying supporting components (RocketMQ's NameServer, Kafka's ZK/KRaft), and image sizes are often hundreds of MB.
    - Advantage of NATS: NATS is a statically compiled Go binary file.
        - Deployment: `docker run nats` is enough, image < 20MB.
        - Operations: No JVM GC pause issues, no external dependencies, minimal configuration.
        - Cluster: Automatic node discovery (Gossip), full mesh connection, scaling is extremely simple.

- Unified Architecture
    - RocketMQ/Kafka: Mainly solve "asynchronous decoupling" and "peak shaving". If synchronous calls between services are also needed, gRPC or Dubbo usually need to be introduced.
    - NATS: One system handles all communication.
        - Instant Messaging: Core NATS Pub/Sub.
        - RPC Calls: Native Request-Reply mode, extremely high performance, can directly replace gRPC.
        - Persistent Storage: JetStream replaces Kafka/RocketMQ.
        - KV Storage: Built-in distributed KV and Object Store, can even replace some Redis usages.
        - Conclusion: Choosing NATS can reduce the tech stack by 2-3 components.

- Pragmatism

    - Performance is "Enough":

        Although Kafka's extreme throughput (million-level TPS) is higher, for 99% of enterprise applications, this is severe performance overkill. NATS single node easily supports tens of thousands or even hundreds of thousands of TPS, which far exceeds the peak demand of most businesses. Compared to Kafka's pursuit of extreme throughput at the expense of real-time performance, NATS's low latency characteristics bring more intuitive and important experience improvements in daily business.

    - Functionality is "Enough":

        RocketMQ indeed possesses advanced features like transactional messages and scheduled messages, but in microservice practice, these problems can often be solved through architecture design (such as local message tables, independent scheduling services). The core functions provided by NATS (persistence, ACK confirmation, retry mechanism, flow control) already cover 95% of the core needs of distributed communication. To introduce and maintain a huge and complex RocketMQ/Kafka cluster for the remaining 5% of rarely used specific functions is often not cost-effective (ROI). NATS solves the most core problems with minimal operational cost.
