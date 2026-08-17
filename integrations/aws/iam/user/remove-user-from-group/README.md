# `aws/iam/user/remove-user-from-group`

Removes an IAM user from a group.

```bash
bun run bin/ferry.ts aws/iam/user/remove-user-from-group --dry-run
bun run bin/ferry.ts aws/iam/user/remove-user-from-group
```

## What it does

| Step | Notes |
| --- | --- |
| `remove-user-from-group` | shared `iamRemoveUserFromGroupStep` factory — inverted create-or-skip, target state is "the membership is gone" |
| `verify` | polls `ListGroupsForUser` until the group no longer reads back as a membership |

**No user-exists guard.** Unlike `add-user-to-group`, this integration does
not run `iamUserExistsGuardStep` first. That guard always folds a missing
user into `conflict`, which is right for add (you can't add a nonexistent
user) but wrong for remove: if the user (or group) is already gone, the
membership is already gone too, and that's a no-op, not a conflict.
`iamRemoveUserFromGroupStep`'s own `check()` already treats
`NoSuchEntityException` as `exists` (target state achieved), so this
integration is safe to run even if the user was never provisioned or has
since been deleted.

## Params

- `IAM_USER_NAME` — the user to remove from the group.
- `IAM_GROUP_NAME` — the group to remove the user from.

## Gotchas

**Safe to run even if the user or group is already gone.** This is an
idempotent no-op in both cases: `check()` returns `exists` (nothing left to
remove) and `create()` never runs.

**Rollback re-adds only what this run removed.** If the user is deleted
before rollback runs, rollback's own `AddUserToGroup` call catches
`NoSuchEntityException` and logs a warning instead of throwing — the user's
absence supersedes needing the membership back.
