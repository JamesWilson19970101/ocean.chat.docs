import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Microservice Architecture

:::info Architecture Overview
The entire platform is divided into four logical layers, comprising 11 core microservices and 1 data processing pipeline, ensuring a clear separation of responsibilities.
:::

## IM Architecture Diagram

// TODO: Diagram

## Layer 1: Gateway and Access Layer

This layer is the direct entry point for users, focusing on handling massive concurrent connections, and is a critical performance point for the entire system.

### 1. **API Gateway Service (oceanchat-api-gateway)** (Stateless)

<Tabs>
<TabItem value="desc" label="Introduction" default>
This gateway is the sole entry point for external requests.
</TabItem>
<TabItem value="resp" label="Core Responsibilities">

- **HTTP Request Entry Point**: Acts as the single entry point for all external RESTful API requests. Client HTTP requests for login, registration, fetching user profiles, querying history, etc., all arrive here first.
- **Request Routing**: Securely routes requests to the corresponding internal business microservices based on the request's URL path (e.g., /auth/login, /users/profile).
- **Common Cross-Cutting Concerns**: Centrally handles cross-service common functionalities such as authentication (validating JWT), authorization, rate limiting, logging, and SSL offloading.

</TabItem>
<TabItem value="reason" label="Reason for Separation">
To provide a unified, secure, and manageable facade for all stateless HTTP requests. Separating API management from real-time connection management makes responsibilities more singular and easier to scale and maintain independently.
</TabItem>
</Tabs>

### 2. **Connection Gateway Service (oceanchat-ws-gateway)** (Stateful)

<Tabs>
<TabItem value="desc" label="Introduction" default>
Given that this service is stateful, its design should remain business-agnostic, lightweight, and simple.
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

## Process Description

### Login Phase

1.  Client A → **API Gateway** (sends username/password to `/auth/login`).
2.  **API Gateway** → **Auth Service** (forwards login request).
3.  **Auth Service** validates successfully, generates a JWT, and returns it to the **API Gateway**.
4.  **API Gateway** → Client A (responds with the JWT to the client).

### Message Sending Phase

5.  User A sends a message to group G.
6.  Client A → **Connection Gateway-1** (establishes a connection, attaching the JWT).
7.  **Connection Gateway-1** validates the JWT's legitimacy (by calling the **Auth Service**), confirms the user identity as A, and attaches `userId: A` to subsequent messages.
8.  **Connection Gateway-1** → **Message Router Service** (passthrough).
9.  **Message Router Service** → **Message Logic Service** (routing).
10. **Message Logic Service** processes the message (checks permissions, generates ID), then splits into two paths:
    - → **Push Orchestrator Service** (initiates delivery)
    - → NATS persistence topic (prepares for storage)
11. **Push Orchestrator Service** queries the **Presence Service** and learns that group member B is online (on gateway 2), and C is offline.
12. **Push Orchestrator Service** → NATS online push topic (task for B) and NATS offline push topic (task for C).
13. **Real-time Pusher Worker** consumes B's task → instructs **Connection Gateway-2** → Client B receives the message.
14. **Offline Pusher Worker** consumes C's task → calls APNS/FCM API → Client C receives a notification.
15. **Persistence Writer** subscribes to and consumes the NATS message → writes to MongoDB.
