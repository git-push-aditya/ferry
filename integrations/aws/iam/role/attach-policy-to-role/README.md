# `aws/iam/role/attach-policy-to-role`

Attaches a managed policy to an IAM role that already exists. Does not create
the role; run `aws/iam/role/create-role` first if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/iam/role/attach-policy-to-role --dry-run
bun run bin/ferry.ts aws/iam/role/attach-policy-to-role
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-role-exists` | aborts in the plan phase (as `conflict`) if the role doesn't exist |
| `attach-role-policy` | shared `iamAttachRolePolicyStep` factory — create-or-skip, checks `ListAttachedRolePolicies` first so rollback never detaches an attachment this run didn't add |
| `verify` | polls `ListAttachedRolePolicies` until the ARN reads back as attached |

## Params

- `ROLE_NAME` — the existing role to attach the policy to.
- `POLICY_ARN` — full ARN of the policy, AWS-managed or customer-managed
  (e.g. `arn:aws:iam::aws:policy/ReadOnlyAccess` or
  `arn:aws:iam::123456789012:policy/my-policy`). If you only have a
  customer-managed policy *name*, resolve it to an ARN yourself with
  `policyArn(accountId, name)` (`src/providers/aws/iam.ts`) before writing it
  here — this integration takes a single ARN param rather than a second
  `POLICY_NAME` resolution path, per the plan.

## Gotchas

**Re-running with the same `.env` is a safe no-op.** `AttachRolePolicy` is
itself idempotent on AWS's side, and `check()` also short-circuits once the
attachment is already present.

**Rollback only ever undoes what this run attached.** If the policy was
already attached before this run (by another process or a prior run),
`check()` returns `exists`, `create()` never runs, and a later failure in the
same integration will not strip that pre-existing attachment.
