import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Caching

Caching is indispensable when building high-performance, high-availability backend services. it significantly reduces database pressure and accelerates data response times. This document explores the multi-level caching architecture, caching strategies, and solutions to classic caching problems adopted in our system design.

## Multi-level Caching

The system employs a multi-level caching architecture consisting of **Local Memory Cache (L1) + Distributed Cache (L2)** to meet different access requirements.

:::info Typical Use Case: User Presence

User presence status involves extremely frequent read and write operations, making it the ideal scenario for multi-level caching.

- **L1 (Local Memory Cache)**: Each IM server caches the status and routing information of all users currently connected to that specific instance in its own memory. This provides millisecond-level access for handling message forwarding and status queries within the local node.
- **L2 (Redis Distributed Cache)**: Redis stores the status and routing information for all online users across the entire network. When cross-server communication occurs and the L1 cache misses, the L2 cache is queried.

:::

## Caching Strategies

### Read Operations (Cache-Aside Pattern)

1.  The application first attempts to retrieve data from **Redis**.
2.  If data exists in Redis (**Cache Hit**), it is returned directly.
3.  If data is not in Redis (**Cache Miss**), it is queried from **MongoDB**.
4.  The data retrieved from MongoDB is written back to Redis (with an appropriate expiration time) and then returned to the application.

:::tip Advantages
The logic is simple and easy to implement. As a "Lazy Loading" pattern, only data that is actually requested is cached, effectively saving cache space.
:::

:::caution Disadvantages
The first request for a piece of data incurs the overhead of a cache miss (one Redis access + one DB access), leading to a slightly longer response time.
:::

### Write Operations

When data changes (e.g., an administrator modifies a configuration), consistency between the cache and the database must be maintained.

<Tabs>
<TabItem value="a" label="Scheme A: Update DB then Delete Cache (Recommended)" default>

1.  The service receives an update request.
2.  The new value is written to **MongoDB**.
3.  Upon success, a `DEL` command is sent to Redis to **delete** the corresponding cache key.

**Advantages**:

- Simple and reliable; it is a standard industry practice.
- The next time the data is read, a cache miss occurs, and the latest value is automatically loaded from the database and written back to the cache, ensuring eventual consistency.

**Disadvantages**:

- If the cache deletion fails, the database will have new data while the cache holds old data, leading to short-term inconsistency (until the cache expires). This is a low-probability event and can be mitigated through retry mechanisms.

</TabItem>
<TabItem value="b" label="Scheme B: Delete Cache then Update DB">

1.  The service receives an update request.
2.  A `DEL` command is sent to Redis to **delete** the corresponding cache key.
3.  The new value is written to **MongoDB**.

:::danger Serious BUG
In high-concurrency scenarios, this scheme can lead to **permanent data inconsistency** between the database and the cache (until the cache expires naturally).

**Timing Issue**:

1. Request A initiates an update and deletes the Redis cache first.
2. Simultaneously, Request B initiates a read and finds the Redis cache missing.
3. Request B reads the **old value** from the database and writes it into Redis.
4. Request A completes the database update.

The end result: the database contains the new value, but the Redis cache contains the old value, which will persist until it naturally expires.
:::

</TabItem>
</Tabs>

## Classic Problems

### Cache Penetration

**Phenomenon**: A large volume of requests (malicious or accidental) targets a key that **does not exist** in the database. Since it's also missing from the cache, all requests hit the database directly, potentially causing it to crash.

:::tip Solution: Cache Nulls
When a query to the database for a non-existent key returns no results, cache a special "null value" (e.g., a predefined string `"NULL"`) in Redis for that key with a short expiration time (e.g., 1-5 minutes). Subsequent requests for the same non-existent key will hit the "null cache," protecting the database.
:::

### Cache Breakdown (Hotspot Key Invalidation)

**Phenomenon**: A **Hotspot Key** (a configuration or item accessed with extremely high frequency) suddenly expires. At that exact moment, a massive burst of concurrent requests misses the cache and floods the database simultaneously, causing a dramatic spike in pressure.

:::tip Solution: Use Distributed Locks

1. When a cache miss occurs, not all requests are allowed to query the database.
2. Only one request can acquire a Redis-based distributed lock (e.g., using the `SET key value NX PX milliseconds` command).
3. This single request is responsible for querying the database and backfilling the cache before releasing the lock.
4. Other requests that fail to acquire the lock wait briefly and then retry (by which time they will likely hit the cache).
   :::

### Cache Avalanche

**Phenomenon**: **A large number of keys expire at the same time** (e.g., if all cache expiration times are set identically after a service restart), causing all requests to hit the database at once.

:::tip Solution: Add Jitter to Expiration Times
When setting the base expiration time, add a small random offset. For example, instead of setting all keys to a 60-minute TTL, set them to `60 minutes + (a random value between 0-5 minutes)`. This spreads out the expiration times and avoids concentrated failures.
:::

### Cache Warm-up

:::info Concept: Cache Warm-up
When a service (especially a newly started instance in a microservices architecture) first launches, the Redis cache is empty. A sudden influx of requests would penetrate the cache and hit the database directly, causing a "Cold Start" problem. Cache Warm-up involves pre-loading hotspot data or essential base data into the cache during the service startup phase.
:::

### Cache Degradation

:::caution Concept: Cache Degradation
In distributed systems, any external dependency (like Redis) can fail. If the Redis service becomes unavailable and the code logic strictly depends on it, the entire function or even dependent services might crash. Cache Degradation is a fault-tolerance mechanism: when the cache service is abnormal, the system "degrades" to reading and writing directly to the database to ensure the availability of core functions, albeit with reduced performance.
:::
