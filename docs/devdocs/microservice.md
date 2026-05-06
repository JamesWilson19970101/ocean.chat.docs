import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Microservice Architecture

:::info Architecture Overview
The entire platform is a distributed microservice architecture designed to support 10 million-level (100k+) concurrency. It is divided into four logical layers, comprising 11 core microservices and 1 data processing pipeline, ensuring a clear separation of responsibilities.
:::

## Technology Stack

The project is built upon a modern and robust technology stack, chosen for its performance, scalability, and developer experience.

- **[NestJS 11](https://nestjs.com/)**: A progressive Node.js framework for building efficient, reliable, and scalable server-side applications. Its modular architecture is perfectly suited for developing the microservices in this project.
- **[TypeScript 5](https://www.typescriptlang.org/)**: The primary programming language for the project. By adding static types to JavaScript, it helps improve code quality, readability, and maintainability, which is crucial for large-scale projects.
- **[Yarn 4.7](https://yarnpkg.com/)**: A fast, reliable, and secure dependency manager used to efficiently manage the project's packages and dependencies.
- **[MongoDB](https://www.mongodb.com/) (with [Mongoose](https://mongoosejs.com/))**: The primary NoSQL database for persistent data storage. It is used to store user data, messages, group information, etc. Mongoose serves as an Object Data Modeling (ODM) library, providing a schema-based solution for modeling application data.
- **[Redis](https://redis.io/)**: A high-performance in-memory data store. In this project, it is used for caching, real-time user presence management, and as a high-speed message bus for certain real-time communication scenarios.
- **[NATS](https://nats.io/) (with JetStream)**: A simple, secure, and high-performance open-source messaging system that serves as the main communication backbone between microservices. The project specifically utilizes **NATS JetStream**, its built-in persistence engine, to provide at-least-once message delivery guarantees. This is critical for reliable asynchronous operations like persisting messages, handling offline pushes, and broadcasting domain events.

## IM Architecture Diagram

// TODO: Diagram

## Layer 1: Gateway and Access Layer

This layer is the direct entry point for users, focusing on handling massive concurrent connections, and is a critical performance point for the entire system.

### 1. **API Gateway Service (oceanchat-api-gateway)** (Stateless)

<Tabs>
<TabItem value="desc" label="Introduction" default>
This gateway is the sole entry point for external http requests.
</TabItem>
<TabItem value="resp" label="Core Responsibilities">

- **Request Routing**: Core functionality. It serves as the sole entry point for all external RESTful API requests. Client HTTP requests for login, registration, retrieving user information, and querying history all arrive here first. Then, requests are forwarded to the appropriate services according to rules. For example, requests starting with `/auth/*` are forwarded to the `oceanchat-auth` service, and `/users/*` are forwarded to the `oceanchat-user` service.
- **Authentication**: Implements **Zero-I/O Authentication**. It cryptographically verifies the RS256 Access Token and performs an `O(1)` local memory lookup against a token blacklist (populated via NATS JetStream events), entirely eliminating synchronous network I/O (like Redis queries) from the critical path to support 100k+ concurrency. Interfaces that do not require authentication are allowed directly.
- **Rate Limiting**: For example, limiting the number of requests from the same IP address to 10 per second to protect backend services from overload.
- **Logs and Monitoring**: Records all incoming and outgoing HTTP request logs for troubleshooting and performance analysis.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To provide a unified, secure, and manageable facade for all stateless HTTP requests. Separating API management from real-time connection management makes responsibilities more singular and easier to scale and maintain independently.
</TabItem>
</Tabs>

### 2. **Connection Gateway Service (oceanchat-ws-gateway)** (Stateless)

<Tabs>
<TabItem value="desc" label="Introduction" default>
Given that this service is Stateless, its design should remain business-agnostic, lightweight, and simple.
</TabItem>
<TabItem value="resp" label="Core Responsibilities">

- **Real-time Connection Entry Point**: Serves as the sole entry point for all external WebSocket/TCP long-lived connections.
- **Connection Authentication**: Responsible for authenticating the connection when a client establishes a long-lived connection (by calling the "Auth Service" or using a shared public key for local validation).
- **Data Passthrough**: Acts as a pure connection channel, only encapsulating the client's raw data packet (e.g., by attaching `connectionId`, `gatewayId`) and then quickly delivering it to the backend **Message Router Service**.
- **Client Message Delivery**: Receives instructions from the **Real-time Pusher Worker** and accurately pushes messages to clients connected to this instance.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To completely separate the most resource-intensive I/O-bound tasks (maintaining connections) from CPU-bound tasks (business logic). This allows the Connection Gateway to be extremely optimized and scaled horizontally independently to support tens or even hundreds of millions of concurrent connections.
</TabItem>
</Tabs>

### 3. **Message Router Service (oceanchat-router)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Message Decoding and Dispatching**: Receives raw data packets from the **Connection Gateway**, performs decoding, protocol parsing, and initial validation.
- **Business Routing**: Determines which business microservice should handle the message based on its type, and then dispatches it via the NATS message queue.
- **Upstream Traffic Control**: Implements general rate limiting and circuit breaking. For example, limiting "a maximum of 100 requests per second per user ID". More fine-grained business rate limiting (like group creation frequency) should be implemented in the specific services.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Decouples the access layer from the business logic layer. The router service acts as an intermediary coordinator, making the addition, removal, and changes of backend business services completely transparent to the gateway layer, greatly improving system flexibility and maintainability.
</TabItem>
</Tabs>

## Layer 2: Core Business Logic Layer

This layer is responsible for handling all the core business functions of the IM platform, designed as stateless services for easy horizontal scaling.

### 4. **Auth Service (oceanchat-auth)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **User Authentication**: Handles user registration, login, logout, and other HTTP requests proxied by the API Gateway.
- **Token Management**: Responsible for generating, validating, and refreshing access tokens (JWT recommended), which is the core of system security.
- **Provide Validation Capability**: Provides internal interfaces for other microservices (especially the **Connection Gateway**) to validate token effectiveness.
- **Publish Domain Events**: Publishes asynchronous domain events to NATS JetStream upon the completion of critical business operations (e.g., user registration, login), allowing other services to subscribe and react.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Isolates the common and critical security capability of user authentication into a single, trusted service. All other services rely on it to confirm user identity, making responsibilities clear and facilitating unified management of security policies.
</TabItem>
</Tabs>

### 5. **User & Relationship Service (oceanchat-user)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Data Management**: Manages user accounts, profiles, friend relationships (add/delete/blacklist), address books, etc.
- **Authorization Decision-Making**: As the sole owner of relationship data, it is responsible for making permission judgments for related operations (e.g., answering "Are user A and B friends?").

</TabItem>
<TabItem value="reason" label="Reason for Separation">
User and relationship data are the foundational data of an IM system. An independent service can provide a unified and stable data source for other services. Co-locating the authorization decision logic within this service ensures the consistency of data and rules.
</TabItem>
</Tabs>

### 6. **Group Service (oceanchat-group)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Lifecycle Management**: Responsible for group creation/dissolution, member management, permission systems, group announcements, group settings, etc.
- **Authorization Decision-Making**: As the sole owner of group data, it contains all group-related authorization logic (e.g., determining if a user is a group member, is muted, etc.).

</TabItem>
<TabItem value="reason" label="Reason for Separation">
The business logic for group chats (especially permissions and member management) is very complex. Separating it into a service helps reduce code complexity and facilitates independent development and iteration.
</TabItem>
</Tabs>

### 7. **Message Logic Service (oceanchat-message)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Permission Check Coordination**: Acts as a "coordinator" for permission checks, calling the correct "decision-maker" service to complete the check. For example, it calls the **User & Relationship Service** for one-on-one messages and the **Group Service** for group messages.
- **Message Processing**: As the business processing center for one-on-one and group messages, it's responsible for permission checks, content processing (@mentions, sensitive word filtering), generating message IDs, assembling the message body, etc.
- **Triggering Delivery**: After processing is complete, it calls the **Push Orchestrator Service** to start the message delivery process.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Separates the business logic of the message itself ("what it is") from the message delivery process ("how it's sent"), making responsibilities clearer.
</TabItem>
</Tabs>

## Layer 3: Message Push Pipeline

This is the key to ensuring reliable, real-time message delivery, and it is a highly asynchronous processing flow.

### 8. **Push Orchestrator Service (oceanchat-orchestrator)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Delivery Decision-Making**: Receives messages to be delivered from the **Message Logic Service**.
- **Status Query**: Queries the **Presence Service** in real-time to get the online status and gateway node of all recipients.
- **Task Dispatching**: Splits the message into "online push tasks" and "offline push tasks" based on the online status, and publishes them to different NATS subjects (using JetStream to ensure persistence).

</TabItem>
<TabItem value="reason" label="Reason for Separation">
As the "brain" of message delivery, it is responsible for complex decision-making logic. Isolating it makes the push flow clearer and easier to monitor and debug.
</TabItem>
</Tabs>

### 9. **Real-time Pusher Worker (oceanchat-pusher-realtime)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Task Consumption**: Listens to the "online push" queue and consumes tasks.
- **Command Issuance**: Directly communicates with the **Connection Gateway** instance where the target user is located, instructing it to deliver the message.
- **Tech Stack**: NATS JetStream subscriber, ioredis (for inter-gateway Pub/Sub).

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Dedicated to handling online message pushing, it can be scaled independently based on the number of online users and message volume to ensure real-time performance.
</TabItem>
</Tabs>

### 10. **Offline Pusher Worker (oceanchat-pusher-offline)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Task Consumption**: Subscribes to the "offline push" topic and consumes tasks.
- **API Calling**: Calls the push APIs of Apple APNS, Google FCM, or domestic vendors to send offline notifications.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Integration with third-party APIs comes with network latency and uncertainty. Isolating it prevents its failures or slowness from affecting the core real-time push link.
</TabItem>
</Tabs>

## Layer 4: Foundational Support Services

These services provide stable and efficient foundational capabilities for the entire platform.

### 11. **Presence Service (oceanchat-presence)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Status Maintenance**: Maintains the global online status of users in real-time through a `userId -> {gatewayId, status}` mapping.
- **Status Query**: Provides millisecond-level online status query interfaces for services like the **Push Orchestrator Service**.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Online presence is the cornerstone of a distributed IM system, with extremely frequent reads and writes. An independent service, highly optimized with an in-memory database like Redis, ensures high performance.
</TabItem>
</Tabs>

### 12. **Query Service (oceanchat-query)** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Unified Query Entry Point**: Provides a unified HTTP API for clients to query data such as message history and session lists.
- **Tiered Query**: Intelligently fetches and aggregates data from different storage media (Redis cache, MongoDB, etc.) based on the query's time range.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Implements read-write splitting. Separating high-frequency read operations from the core write path allows for independent optimization of query performance without affecting the stability of message writing.
</TabItem>
</Tabs>

### Data Processing Pipeline (MessagePersistence): Message Persistence

:::note This is an asynchronous process, not an independent service

- **Core Responsibility**: After the **Message Logic Service** processes a message, besides calling the push service, it also sends a copy of the message to a dedicated NATS topic for persistence (backed by JetStream). One or more independent **subscriber processes (Writers)** will listen to this queue and batch-write the messages to the database.

- **Reason for Separation**: Complete asynchronicity. The sending and receiving of messages should not wait for the database write to complete. This "write-after-persistence" design maximizes the real-time nature of messages.

:::
