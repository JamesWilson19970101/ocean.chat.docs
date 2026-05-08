import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Caching

When building high-performance, highly available backend services, caching is an indispensable component. It significantly reduces the access pressure on the database and accelerates data response times. This article explores the multi-level cache architecture, caching strategies, and solutions to classic caching problems adopted in our system design.

## Multi-Level Cache

The system adopts a multi-level cache architecture of **Local In-Memory Cache (L1) + Distributed Cache (L2)** to handle different access requirements.

:::info Typical Scenario: User Online Presence

User online status requires extremely frequent reads and writes, making it the perfect scenario for multi-level caching.

- **L1 (Local In-Memory Cache)**: Every IM server caches the status and routing information of all users currently connected to that specific machine in its own memory. This provides millisecond-level access speed for processing message routing and status queries within the machine.
- **L2 (Redis Distributed Cache)**: Redis stores the status and routing information of all online users across the entire network. When cross-server communication occurs, if the L1 cache misses, the L2 cache is queried.

:::

## Caching Strategy

### Read Operations (Cache-Aside Pattern)

1.  The application first attempts to get data from **Redis**.
2.  If the data exists in Redis (**Cache Hit**), it returns it directly.
3.  If the data does not exist in Redis (**Cache Miss**), it queries **MongoDB**.
4.  The data retrieved from MongoDB is written into Redis (with a reasonable expiration time) and then returned to the application.

:::tip Advantages
The logic is simple and easy to implement. Furthermore, this is a "lazy loading" pattern; only data that is actually requested is cached, effectively saving cache space.
:::

:::caution Disadvantages
For the first request of a piece of data, there is the overhead of a cache miss (one Redis access + one DB access), resulting in a slightly longer response time.
:::

### Write Operations

When data is modified (e.g., an administrator changes a configuration), the consistency between the cache and the database must be guaranteed.

<Tabs>
<TabItem value="a" label="Plan A: Update DB first, then Delete Cache (Recommended)" default>

1.  The service receives an update request.
2.  The new value is written to **MongoDB**.
3.  Upon success, a `DEL` command is sent to Redis to **delete** the corresponding cache key.

**Advantages**:
- Simple and reliable; it is one of the industry standard practices.
- The next time the data is read, a cache miss will occur, automatically loading the latest value from the database and backfilling the cache, ensuring eventual consistency.

**Disadvantages**:
- If the cache deletion fails, the database will have the new value while the cache retains the old one, leading to brief data inconsistency (until the cache expires). However, this is a low-probability event and can be mitigated through retry mechanisms.

</TabItem>
<TabItem value="b" label="Plan B: Delete Cache first, then Update DB">

1.  The service receives an update request.
2.  A `DEL` command is sent to Redis to **delete** the corresponding cache key.
3.  The new value is written to **MongoDB**.

:::danger Critical Bug Exists
In high-concurrency scenarios, this plan can lead to **permanent data inconsistency** between the database and the cache (until the cache expires naturally).

**Timing Issue**:
1. Request A initiates an update operation and first deletes the Redis cache.
2. At this moment, Request B initiates a read operation and finds the Redis cache is empty.
3. Request B reads the **old value** from the database and writes it into Redis.
4. Request A completes the update operation in the database.

Final result: The database holds the new value, but the Redis cache holds the old value, and this old value will persist until it naturally expires.
:::

</TabItem>
</Tabs>

## Classic Problems

### Cache Penetration

**Phenomenon**: Malicious or accidental massive requests for a Key that **does not exist at all** in the database. Since it's not in the cache either, all requests will hit the database directly, potentially causing it to crash.

:::tip Solution: Cache Nulls
When querying a non-existent Key from the database, cache a special "null value" (e.g., an agreed-upon string `"NULL"`) for this Key in Redis as well, and set a relatively short expiration time (e.g., 1-5 minutes). This way, subsequent requests for this non-existent Key will hit the "null value cache" and return directly, thereby protecting the database.
:::

### Cache Breakdown

**Phenomenon**: A certain **hotspot Key** (e.g., an extremely frequently accessed setting) suddenly expires. At that exact moment, massive concurrent requests flood in, experience a cache miss, and all proceed to request the database simultaneously, causing a sudden spike in database pressure.

:::tip Solution: Use Distributed Locks
1. When a cache miss occurs, not all requests go to query the database.
2. Only one request is allowed to acquire a Redis-based distributed lock (e.g., using the `SET key value NX PX milliseconds` command).
3. This request is responsible for querying the data from the database, backfilling the cache, and then releasing the lock.
4. Other requests that failed to acquire the lock will wait for a short moment and retry (by then, they will highly likely be able to get the data from the cache).
:::

### Cache Avalanche

**Phenomenon**: **A large number of Keys expire collectively at the same time** (for instance, after a service restart, the expiration times for all cached items are set identically), causing all requests to instantaneously hit the database.

:::tip Solution: Add Random Values to Expiration Times
While setting the base expiration time, add a small random number to it. For example, instead of setting the TTL of all Keys to exactly 60 minutes, set it to `60 minutes + (a random value between 0-5 minutes)`. This scatters the expiration times, avoiding concentrated failures.
:::

### Cache Warm-up

:::info Concept: Cache Warm-up
When a service (especially a newly started instance in a microservice architecture) first starts, the Redis cache is empty. If a large number of requests flood in at this time, they will all penetrate the cache and access the database directly, bringing enormous pressure to the database. This is also known as the "cold start" problem. Cache warm-up refers to proactively loading hotspot data or full basic data into the cache during the service startup phase.
:::

### Cache Degrade

:::caution Concept: Cache Degrade
In a distributed system, any external dependency (like Redis) can experience failures. If the Redis service becomes unavailable and our code logic strongly depends on it, the entire function and even other services relying on it might crash. Cache degradation is a fault-tolerance mechanism: when the cache service is abnormal, the system can gracefully degrade to reading and writing directly from/to the database, guaranteeing the availability of core functions, albeit with reduced performance.
:::
