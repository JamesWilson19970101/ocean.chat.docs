# Distributed System Related Issues

## Distributed Transactions

Distributed transactions are almost never needed for the core "chat" function; however, they might be required for a complete "IM platform."

Ocean Chat needs to be viewed in two separate worlds:

- One is the information flow (messages).

- The other is the flow of funds/status (value).

### Places Where Distributed Transactions Should Absolutely Not Be Used: Core Chat

Any code that affects the user's "message sending speed" and "message receiving success rate" will not use strongly consistent distributed transactions (such as TCC/Seata-AT).

Why?

Different concurrency levels: WeChat sends millions of messages per second, but only a few thousand red envelopes per second. Distributed transactions (Saga/TCC) involve multiple database operations and locks, resulting in significant performance overhead, and simply cannot handle the high concurrency of message flows.

Different tolerance levels: A 1-second delay in message arrival (eventual consistency) might be imperceptible to users; however, if ensuring consistency causes a 1-second delay in message sending, users will immediately uninstall the app.

This platform plans to use an eventual consistency solution of "local transactions + NATS retries".

### Must-use or highly probable application: Value-added services

A mature IM platform is not limited to text messaging. When developing the following functions, distributed transactions (Saga or TCC) must be used:

1. Wallet and Red Packet System (Fund Flow)

    This is the most typical distributed transaction scenario in IM.

    - Scenario: User A sends a 100 RMB red packet.

    - Problem: If the wallet deducts the money, the red packet generation fails; or the red packet is generated, but the wallet doesn't deduct the money.

    - Solution: "Retry" cannot be used here. Financial matters must be handled rigorously.

    - TCC (Try-Confirm-Cancel) mode is required.

    - Try: Freeze 100 yuan in user A's account.

    - Confirm: Deduct the payment and generate a red envelope.

    - Cancel: If red envelope generation fails, unfreeze the 100 yuan.

2. Paid Group Entry (Benefit Exchange)

    - Scenario: A user pays 50 yuan to join a high-end technical group.

    - Logic: Only successful payment allows entry into the group; if entry fails (e.g., the group is full), an automatic refund must be issued.

    - Solution: This is a standard Saga scenario.

    - Positive Process: Deduction -> Group Entry.

    - Compensation: Group Entry Failure -> Refund Logic Triggered.

3. Cross-Tenant/Cross-Shard Group Operations (Data Migration)

    - Scenario: IM becomes large, MongoDB implements sharding, or a SaaS version of IM is implemented.

    - Logic: Migrate a very large group from shard A to shard B to balance the load.