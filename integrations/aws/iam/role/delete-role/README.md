# `aws/iam/role/delete-role`

Deletes an ordinary IAM role: detaches every managed policy, deletes every
inline policy, removes it from every instance profile, then deletes the role
itself — `DeleteRole`'s own documented precondition, in that order.

```bash
bun run bin/ferry.ts aws/iam/role/delete-role --dry-run
bun run bin/ferry.ts aws/iam/role/delete-role
```

## What it does

`check()` maps the create-or-skip contract onto a delete, the same inversion
`delete-empty-bucket` uses: the role already being gone is `"exists"` (the
target state — deletion — is already achieved, so a re-run after a
successful delete is a clean no-op). A present, ordinary role is `"missing"`
(deletion still needs to happen). A present **service-linked** role is
`"conflict"` — `DeleteRole` rejects those outright with `UnmodifiableEntity`,
so this task refuses rather than failing mid-apply; use a dedicated
delete-service-linked-role task (the async `DeleteServiceLinkedRole` +
`GetServiceLinkedRoleDeletionStatus` flow) instead.

The delete itself is one aggregate step, not a step-factory: the set of
attachments to clean up is discovered dynamically from live IAM state at
delete-time, so it has to be handled as one indivisible
detach-then-delete-then-remove transaction.

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `ROLE_NAME` | plain AWS name |
| `DELETE_INSTANCE_PROFILES_TOO` | optional, default `false` |

## Gotchas

**Rollback is best-effort, not a real restore.** Once the role is deleted,
its `RoleId` is gone for good. Rollback recreates the role shell from a
pre-delete snapshot (trust policy, path, description, max session duration,
tags) and re-attaches everything that was captured, but the recreated role
gets a **new RoleId**. Any resource policy or trust relationship keyed on the
old RoleId — some cross-account bucket policies, for example — will not
automatically re-authorize. Any activity/last-used history is also gone.

**Never deletes a shared instance profile.** `DELETE_INSTANCE_PROFILES_TOO`
only deletes a profile if, after removing this role, no other roles remain
attached to it. A profile shared with another role is skipped with a
warning, not silently kept forever, but never deleted out from under another
role either.

**Won't touch a service-linked role.** `check()` refuses in the plan phase —
before any mutation — rather than letting `DeleteRoleCommand` fail partway
through with `UnmodifiableEntity`.

**Partial-failure re-runs resume cleanly.** If a prior run crashed after
detaching some policies but before `DeleteRoleCommand`, a re-run's fresh
`List*` calls simply see fewer attachments left and only clean up what
remains — nothing is double-detached or double-deleted.
