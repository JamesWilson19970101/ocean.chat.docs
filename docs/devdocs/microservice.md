import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Microservice Architecture

:::info Architecture Overview
The entire platform is divided into four logical layers, containing 11 core microservices and 1 data processing pipeline, ensuring a clear separation of responsibilities.
:::

## IM Architecture Diagram

// TODO: Diagram

## Layer 1: Gateway and Access Layer

This layer is the direct entry point for users, focusing on handling massive concurrent connections, and is a performance-critical point of the entire system.

### 1. **Connection Gateway Service** (Stateful)

<Tabs>
<TabItem value="desc" label="Introduction" default>
Given that this service is stateful, the design aims to keep it as business-agnostic, lightweight, and simple as possible.
</TabItem>
<TabItem value="resp" label="Core Responsibilities">

- **Connection Authentication**: When a client establishes a connection, it's responsible for validating the legitimacy of its Token (e.g., JWT). After authentication, the parsed `userId` is attached to all subsequent upstream messages.
- **Protocol Handling**: Maintains client WebSocket/TCP long-lived connections, handling heartbeats, connection establishment, and disconnection.
- **Data Passthrough**: Acts as a pure connection channel, only encapsulating the client's raw data packets (e.g., by adding `connectionId`, `gatewayId`) and then quickly delivering them to the backend **Message Routing Service**.
- **Message Delivery**: Receives instructions from the **Real-time Push Worker** and accurately pushes messages to clients connected to this instance.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To completely separate the most resource-intensive I/O tasks (maintaining connections) from CPU-intensive tasks (business logic). This allows the Connection Gateway to be highly optimized and scaled horizontally to support tens or even hundreds of millions of concurrent connections.
</TabItem>
</Tabs>

### 2. **Message Routing Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Message Decoding and Dispatching**: Receives raw data packets from the **Connection Gateway**, performs decoding, protocol parsing, and initial validation.
- **Business Routing**: Determines which business microservice should handle the message based on its type, then dispatches it via the NATS message queue.
- **Upstream Traffic Control**: Implements generic rate limiting and circuit breaking. For example, limiting "each user ID to forward a maximum of 100 requests per second". More granular business-specific rate limiting (like group creation frequency) should be implemented in the respective services.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To decouple the access layer from the business logic layer. The routing service acts as a middle coordinator, making the addition, removal, and changes of backend business services completely transparent to the gateway layer, greatly improving system flexibility and maintainability.
</TabItem>
</Tabs>

## Layer 2: Core Business Logic Layer

This layer is responsible for handling all core business functions of the IM platform. It is designed as a stateless service for easy horizontal scaling.

### 3. **Authentication Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **User Authentication**: Provides standard HTTP interfaces for user registration, login, and logout.
- **Token Management**: Responsible for generating, validating, and refreshing access tokens (JWT recommended), which is the core of system security.
- **Validation Capability**: Provides an internal interface for other microservices (especially the **Connection Gateway**) to validate token legitimacy.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To isolate the universal and critical security capability of user authentication into a single, trusted service. All other services rely on it to confirm user identity, ensuring clear responsibilities and unified management of security policies.
</TabItem>
</Tabs>

### 4. **User & Relationship Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Data Management**: Manages user accounts, profiles, friend relationships (add/delete/blacklist), contacts, etc.
- **Permission Decision**: As the sole owner of relationship data, it is responsible for making permission judgments for related operations (e.g., answering "Are user A and B friends?").

</TabItem>
<TabItem value="reason" label="Reason for Separation">
User and relationship data are fundamental to an IM system. An independent service provides a unified and stable data source for other services. Co-locating permission decision logic within this service ensures data and rule consistency.
</TabItem>
</Tabs>

### 5. **Group Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Lifecycle Management**: Responsible for group creation/disbandment, member management, permission systems, group announcements, group settings, etc.
- **Permission Decision**: As the sole owner of group data, it contains all group-related permission logic (e.g., determining if a user is a group member, is muted, etc.).

</TabItem>
<TabItem value="reason" label="Reason for Separation">
The business logic for group chats (especially permissions and member management) is very complex. Separating it into a service helps reduce code complexity and facilitates independent development and iteration.
</TabItem>
</Tabs>

### 6. **Message Logic Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Permission Coordination**: Acts as a "coordinator" for permission checks, calling the correct "decision-maker" service. For example, it calls the **User & Relationship Service** for one-on-one messages and the **Group Service** for group messages.
- **Message Processing**: As the business processing center for messages, it handles permission checks, content processing (@mentions, sensitive word filtering), generating message IDs, and assembling the message body.
- **Triggering Delivery**: After processing is complete, it calls the **Push Orchestration Service** to start the message delivery process.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To separate the business logic of the message itself ("what it is") from the message delivery process ("how it's sent"), making responsibilities clearer.
</TabItem>
</Tabs>

## Layer 3: Message Push Pipeline

This is the key to ensuring reliable and real-time message delivery, and it is a highly asynchronous processing flow.

### 7. **Push Orchestration Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Delivery Decision**: Receives messages to be delivered from the **Message Logic Service**.
- **Status Query**: Queries the **Online Status Service** in real-time to get the online status and gateway node of all recipients.
- **Task Dispatch**: Based on the online status, splits the message into "online push tasks" and "offline push tasks" and atomically writes these tasks to different Kafka queues.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
As the "brain" of message delivery, it handles complex decision-making logic. Isolating it makes the push process clearer and easier to monitor and debug.
</TabItem>
</Tabs>

### 8. **Real-time Push Worker** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Task Consumption**: Listens to the "online push" queue and consumes tasks.
- **Instruction Dispatch**: Communicates directly with the target user's **Connection Gateway** instance, instructing it to deliver the message.
- **Tech Stack**: Kafka consumer, ioredis (for inter-gateway Pub/Sub).

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Dedicated to handling online message pushes, it can be scaled independently based on the number of online users and message volume to ensure real-time performance.
</TabItem>
</Tabs>

### 9. **Offline Push Worker** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Task Consumption**: Listens to the "offline push" queue and consumes tasks.
- **API Calls**: Calls Apple APNS, Google FCM, or domestic vendor push APIs to send offline notifications.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Integration with third-party APIs often involves network latency and uncertainty. Isolating it prevents its failures or slowness from affecting the core real-time push pipeline.
</TabItem>
</Tabs>

## Layer 4: Foundational Support Services

These services provide stable and efficient foundational capabilities for the entire platform.

### 10. **Online Status Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Status Maintenance**: Maintains the global online status of users in real-time through a `userId -> {gatewayId, status}` mapping.
- **Status Query**: Provides millisecond-level online status query interfaces for services like the **Push Orchestration Service**.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Online status is the cornerstone of a distributed IM system, with extremely high read and write frequency. An independent service using an in-memory database like Redis allows for extreme optimization to ensure high performance.
</TabItem>
</Tabs>

### 11. **Data Query Service** (Stateless)

<Tabs>
<TabItem value="resp" label="Core Responsibilities" default>

- **Unified Query Entrypoint**: Provides a unified HTTP API for clients to query historical messages, conversation lists, etc.
- **Tiered Query**: Intelligently pulls and aggregates data from different storage media (Redis cache, MongoDB, etc.) based on the query's time range.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
Implements read-write separation. Separating high-frequency read operations from the core write pipeline allows for independent optimization of query performance without affecting the stability of message writing.
</TabItem>
</Tabs>

### Data Processing Pipeline: Message Persistence

:::note This is an asynchronous process, not an independent service

- **Core Responsibilities**: After the **Message Logic Service** processes a message, besides calling the push service, it also sends a copy of the message to a dedicated persistence Kafka queue. One or more independent **consumer processes (Writers)** listen to this queue and batch-write the messages to the database.

- **Reason for Separation**: Complete asynchronicity. Sending and receiving messages should not wait for the database write to complete. This "write-after-persistence" design maximizes message real-time performance.

:::

## Flow Description

### Login Phase

1.  Client A → **Authentication Service** (sends username/password).
2.  **Authentication Service** validates successfully and returns a JWT to Client A.

### Sending Message Phase

3.  User A sends a message to Group G.
4.  Client A → **Connection Gateway-1** (establishes connection, attaching JWT).
5.  **Connection Gateway-1** validates the JWT's legitimacy (by calling **Authentication Service**), confirms user identity as A, and attaches `userId: A` to subsequent messages.
6.  **Connection Gateway-1** → **Message Routing Service** (passthrough).
7.  **Message Routing Service** → **Message Logic Service** (routing).
8.  **Message Logic Service** processes the message (validates permissions, generates ID), then forks into two paths:
    - → **Push Orchestration Service** (initiates delivery)
    - → Kafka persistence queue (prepares for storage)
9.  **Push Orchestration Service** queries the **Online Status Service**, learns that group member B is online (on Gateway-2) and C is offline.
10. **Push Orchestration Service** → sends a task for B to the "online push queue" and a task for C to the "offline push queue".
11. **Real-time Push Worker** consumes task B → instructs **Connection Gateway-2** → Client B receives the message.
12. **Offline Push Worker** consumes task C → calls APNS/FCM API → Client C receives a notification.
13. **Persistence Writer** consumes the message from Kafka → writes it to MongoDB.
