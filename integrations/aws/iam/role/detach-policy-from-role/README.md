# `aws/iam/role/detach-policy-from-role`

Detaches a managed policy from an IAM role.

```bash
bun run bin/ferry.ts aws/iam/role/detach-policy-from-role --dry-run
bun run bin/ferry.ts aws/iam/role/detach-policy-from-role
```

## What it does

| Step | Notes |
| --- | --- |
| `detach-role-policy` | shared `iamDetachRolePolicyStep` factory — inverted create-or-skip, target state is "the attachment is gone" |
| `verify` | polls `ListAttachedRolePolicies` until the ARN no longer reads back as attached |

**No role-exists guard step.** Unlike `attach-policy-to-role`, this
integration does not run `iamRoleExistsGuardStep` first. That guard always
folds a missing role into `conflict`, which is the right call for attach (you
can't attach to nothing) but wrong for detach: if the role is already gone,
the attachment is already gone too, and that's a no-op, not a conflict.
`iamDetachRolePolicyStep`'s own `check()` already treats `NoSuchEntityException`
on the role as `exists` (target state achieved), so this integration is safe
to run even if the role was never provisioned in this account.

## Params

- `ROLE_NAME` — the role to detach the policy from.
- `POLICY_ARN` — full ARN of the policy, same format as
  `attach-policy-to-role`.

## Gotchas

**Safe to run even if the role or policy is already gone.** This is an
idempotent no-op in both cases: `check()` returns `exists` (nothing left to
detach) and `create()` never runs.

**Rollback re-attaches only what this run detached.** If a later step in a
future composed integration deletes the role before rollback runs, rollback's
own `AttachRolePolicy` call catches `NoSuchEntityException` and logs a
warning instead of throwing — the role's absence supersedes needing the
attachment back.
