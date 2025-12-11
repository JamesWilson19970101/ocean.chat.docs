# 并发问题的考虑

:::note
**This article will describe Ocean Chat's thinking on high concurrency and concurrency conflicts.**
:::

## Architecture & Scalability

- **Stateless vs. Stateful Servers:**
    - Stateless: With the exception of the connection gateway, all core business services (e.g., `oceanchat-auth`, `oceanchat-message`) are designed to be stateless. This means any service instance can handle any user's request, making it easy to scale horizontally by simply adding more servers. Service state (like user login sessions) is managed externally and centrally by Redis.

    - Stateful: The `oceanchat-ws-gateway` (Connection Gateway) is the only stateful service in the system. Each instance must maintain the state of the WebSocket connections established with it. To support its scalability, we employ the following strategies:
        - **State Decoupling**: The gateway itself only maintains connection state (e.g., `connectionId`), while the user's business state (e.g., `userId`, presence status) is stored in Redis, making it accessible to all services.
        - **Service Discovery**: A mapping between a `userId` and the `gatewayId` of the instance they are connected to is maintained in Redis. This allows other services (like `oceanchat-pusher-realtime`) to accurately locate the user's gateway instance for pushing messages.

    :::tip
    I've decided to use Redis as the global mechanism for state storage and sharing, effectively decoupling the stateful gateway from the stateless business services.
    :::
- **Load Balancing:**

    I am goging to use nginx, which provides strategies like round-robin, least connections and so on.

- **Horizontal Scaling:**

    This involves load balancing and potentially a way for instances to communicate (e.g., via nats Pub/Sub or another message bus) for cross-instance actions like group messaging.

    :::tip
    Now I am going to use nats as coommunicator among instances. Specifically leveraging its JetStream capabilities, for my inter-service communication.
    :::

- **Node.js Clustering:**

    Utilize Node.js's built-in cluster module to run multiple instances of my application on a single multi-core machine, effectively leveraging all CPU cores. This is crucial for Node.js performance.
    
## Connection Management & Real-time

- **WebSocket Library Choice:**

    - In first phase: I am going to use js library like ws(performant WebSocket library) manage connection.
    
    - In next phase: I am going to use C library manage connection.

## Message Persistence

- **Message Fan-out Strategy:**

    This is CRITICAL for group chats. When one user sends a message to a group of 1000 members, how should I efficiently deliver it to all currently connected members?

    - Pub/Sub: A common pattern is to use a fast message broker like Nats Pub/Sub. The sending server publishes the message to a group-specific channel, and all server instances subscribed to that channel receive it and forward it to their local connected clients belonging to that group. This decouples servers and scales better.

    - Naive Loop: Iterating and sending individually is inefficient and slow.

    :::tip
    I am going to use nats Pub/Sub method deliver message.
    :::

- **Database Choice:**

    - Message Storage: Needs to handle high write volumes.
    
    :::tip
    I am going to use MongoDB.
    :::

    - Session/Presence Store: Needs to be very fast for lookups (e.g., which server is user X connected to? Is user Y online?).

    :::tip
    I am going to use Redis.
    :::

- **<u>Message Queues (Optional but Recommended):</u>**
    
    For tasks that don't need immediate synchronous processing (e.g., generating push notifications, archiving messages, running analytics), use a message queue NATS([Why did I choose NATS?](./message queue.md)) to decouple services and improve resilience. Use Node.js app pushes tasks to the queue, and separate worker processes handle them.

## Performance & Resource Management (Node.js Specifics)

- **Event Loop Blocking:**

    I am extremely careful not to block the Node.js event loop with synchronous or CPU-intensive operations (complex calculations, synchronous I/O, bad regex).

    :::tip
    - Pptional tools to detect event loop blocking:
        - [perf_hooks](https://nodejs.org/api/perf_hooks.html)
        - [Node.js Built-in Profiler (node --prof)](https://nodejs.org/en/learn/getting-started/profiling)
        - [Node.js Inspector (node --inspect or node --inspect-brk)](https://nodejs.org/en/learn/getting-started/debugging):  The Performance tab in Chrome DevTools is extremely powerful. It can record activity while application is under load. Look at the "Main" thread timeline for long, solid yellow blocks labeled "Scripting".
        - [clinic.js](https://clinicjs.org/)
    - [APM (Application Performance Management) & Monitoring Systems](https://guangzhengli.com/blog/zh/indie-hacker-tech-stack-2024#%E7%BD%91%E7%AB%99%E5%88%86%E6%9E%90)
    :::

- **Memory Management:**
    Monitor memory usage closely. Large numbers of connections, large message payloads, or inefficient data handling can lead to memory leaks or high garbage collection overhead. Use tools like [heapdump](https://nodejs.org/en/learn/diagnostics/memory/using-heap-snapshot) and [Node.js profilers](https://nodejs.org/en/learn/getting-started/profiling).
- **Asynchronous Operations:**
    Embrace async/await and Promises correctly. Ensure all I/O is non-blocking.


# Concurrency Conflicts

Because transactions in MongoDB consume a lot of performance. So I am not going to use transactions to solve concurrency conflicts.

I default the last change to the effective change(Last Write Wins), but this leads to lost updates:

- Admin 1 reads group members. Admin 2 reads group members (same list).
- Admin 1 decides to remove User X and prepares the update.
- Admin 2 decides to promote User Y to co-admin and prepares the update (based on the original member list).
- Admin 1 writes (User X removed).
- Admin 2 writes later (User Y promoted, but based on the old list, potentially overwriting the removal of User X if the entire member list is replaced). 

Result: User X might still be in the group (Admin 1's update lost), or User Y's promotion might be based on stale data.

So I just allow one admin change the page, For example, if I find adminA in this interface, it will prompt adminB that the current interface is being operated by adminA, and you cannot modify the settings, you can only query.

I extended the above mentioned strategy to session, only one session is allowed to operate on the same content at the same time. So there will be no concurrent conflicts between the same users.
