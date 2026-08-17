# `aws/iam/user/add-user-to-group`

Adds an existing IAM user to an existing IAM group. Does not create the user
or the group; run `aws/iam/user/create-user` first if the user doesn't exist
yet.

```bash
bun run bin/ferry.ts aws/iam/user/add-user-to-group --dry-run
bun run bin/ferry.ts aws/iam/user/add-user-to-group
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-user-exists` | aborts in the plan phase (as `conflict`) if the user doesn't exist |
| `add-user-to-group` | shared `iamAddUserToGroupStep` factory — create-or-skip, checks `ListGroupsForUser` first so rollback never removes a membership this run didn't add |
| `verify` | polls `ListGroupsForUser` until the group reads back as a membership |

**No group-exists guard.** Group lifecycle isn't among this plan's tasks, so
a missing group isn't checked for up front — `AddUserToGroupCommand` itself
throws `NoSuchEntityException` for a missing group, and the engine surfaces
that as a normal step failure during apply.

## Params

- `IAM_USER_NAME` — the existing user to add to the group.
- `IAM_GROUP_NAME` — the existing group to add the user to.

## Gotchas

**Re-running with the same `.env` is a safe no-op.** `AddUserToGroup` is
itself idempotent on AWS's side, and `check()` also short-circuits once the
membership is already present.

**Rollback only ever undoes what this run added.** If the user was already a
member of the group before this run, `check()` returns `exists`, `create()`
never runs, and a later failure in the same integration will not remove that
pre-existing membership.

**10-groups-per-user default quota.** IAM caps group membership at 10 groups
per user by default. This integration does not pre-check the count; a user
already at the cap will fail the `AddUserToGroup` call with `LimitExceeded`.
