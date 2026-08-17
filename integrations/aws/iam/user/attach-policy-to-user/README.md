# `aws/iam/user/attach-policy-to-user`

Attaches a managed policy to an IAM user that already exists. Does not create
the user; run `aws/iam/user/create-user` first if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/iam/user/attach-policy-to-user --dry-run
bun run bin/ferry.ts aws/iam/user/attach-policy-to-user
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-user-exists` | aborts in the plan phase (as `conflict`) if the user doesn't exist |
| `attach-user-policy` | shared `iamAttachUserPolicyStep` factory — create-or-skip, checks `ListAttachedUserPolicies` first so rollback never detaches an attachment this run didn't add |
| `verify` | polls `ListAttachedUserPolicies` until the ARN reads back as attached |

## Params

- `IAM_USER_NAME` — the existing user to attach the policy to.
- `IAM_POLICY_ARN` — full ARN of the policy, AWS-managed or customer-managed
  (e.g. `arn:aws:iam::aws:policy/ReadOnlyAccess` or
  `arn:aws:iam::123456789012:policy/my-policy`). If you only have a
  customer-managed policy *name*, resolve it to an ARN yourself with
  `policyArn(accountId, name)` (`src/providers/aws/iam.ts`) before writing it
  here — this integration takes a single ARN param rather than a second
  `POLICY_NAME` resolution path, per the plan.

## Gotchas

**Re-running with the same `.env` is a safe no-op.** `AttachUserPolicy` is
itself idempotent on AWS's side, and `check()` also short-circuits once the
attachment is already present.

**Rollback only ever undoes what this run attached.** If the policy was
already attached before this run (by another process or a prior run),
`check()` returns `exists`, `create()` never runs, and a later failure in the
same integration will not strip that pre-existing attachment.
