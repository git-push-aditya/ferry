# `aws/iam/user/detach-policy-from-user`

Detaches a managed policy from an IAM user.

```bash
bun run bin/ferry.ts aws/iam/user/detach-policy-from-user --dry-run
bun run bin/ferry.ts aws/iam/user/detach-policy-from-user
```

## What it does

| Step | Notes |
| --- | --- |
| `detach-user-policy` | shared `iamDetachUserPolicyStep` factory — inverted create-or-skip, target state is "the attachment is gone" |
| `verify` | polls `ListAttachedUserPolicies` until the ARN no longer reads back as attached |

**No user-exists guard step.** Unlike `attach-policy-to-user`, this
integration does not run `iamUserExistsGuardStep` first. That guard always
folds a missing user into `conflict`, which is the right call for attach (you
can't attach to nothing) but wrong for detach: if the user is already gone,
the attachment is already gone too, and that's a no-op, not a conflict.
`iamDetachUserPolicyStep`'s own `check()` already treats `NoSuchEntityException`
on the user as `exists` (target state achieved), so this integration is safe
to run even if the user was never provisioned in this account.

## Params

- `IAM_USER_NAME` — the user to detach the policy from.
- `IAM_POLICY_ARN` — full ARN of the policy, same format as
  `attach-policy-to-user`.

## Gotchas

**Safe to run even if the user or policy is already gone.** This is an
idempotent no-op in both cases: `check()` returns `exists` (nothing left to
detach) and `create()` never runs.

**Rollback re-attaches only what this run detached.** If a later step in a
future composed integration deletes the user before rollback runs, rollback's
own `AttachUserPolicy` call catches `NoSuchEntityException` and logs a
warning instead of throwing — the user's absence supersedes needing the
attachment back.
