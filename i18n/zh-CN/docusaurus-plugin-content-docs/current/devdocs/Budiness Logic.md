# Budiness Logic

:::note 下面的业务规则是零碎的，需要后期整理


## Room

### channel

- 普通公开频道：t: 'c'，teamId: undefined | null | ''。全站用户可见（前提是有 view-c-room 权限）。

- 团队内的公开频道：t: 'c'，teamId: 'xxx'。它是团队的一部分。