# Budiness Logic

:::note The following business rules is fragmented and needed to be organized later.


## Room

### channel

- Public channel (regular): `t: 'c'`, `teamId: undefined | null | ''`. Visible to all users on the site (provided they have view-c-room privileges).
- Public channel within the team: `t: 'c'`, `teamId: 'xxx'`. It is part of the team.