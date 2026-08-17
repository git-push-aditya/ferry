# `aws/iam/role/create-service-linked-role`

Creates a service-linked role for an AWS service, or confirms one already
exists.

```bash
bun run bin/ferry.ts aws/iam/role/create-service-linked-role --dry-run
bun run bin/ferry.ts aws/iam/role/create-service-linked-role
```

## What it does

| Step | Notes |
| --- | --- |
| `create-service-linked-role` | probes `EXPECTED_ROLE_NAME` via `GetRole`; creates it via `CreateServiceLinkedRole` if missing |
| `verify` | confirms the role exists and its `Path` starts with `/aws-service-role/` |

## Why `EXPECTED_ROLE_NAME` is required

Most AWS services publish a fixed service-linked-role name of the form
`AWSServiceRoleFor<Service>`, and some allow a caller-supplied `CustomSuffix`
appended to that prefix to support more than one instance per account. What
"already exists" means for `CreateServiceLinkedRole`, though, genuinely
varies per service — some are singleton-per-account (a second create call
against the same fixed name just errors, but the desired end state, "role
exists", was already true), while others require a distinct `CustomSuffix`
per additional role, and the IAM API reference does not enumerate a single
master list of which services behave which way.

Rather than have Ferry guess the resolved name client-side or rely on
`CreateServiceLinkedRole`'s own error responses to infer whether a duplicate
is benign, this integration requires you to supply the exact resolved role
name yourself, looked up ahead of time from **AWS's own service-linked-role
documentation** for `AWS_SERVICE_NAME` (each service's IAM permissions page
in the AWS docs lists it). `check()` then probes that name directly via
`GetRole` — this is the load-bearing safety mechanism: Ferry never calls
`CreateServiceLinkedRole` speculatively against a role its own `check()`
already found present, so the per-service AlreadyExists variance is
sidestepped entirely rather than guessed at.

## `CUSTOM_SUFFIX` caveat

If you supply a `CUSTOM_SUFFIX` and the create call fails, do not blindly
retry without it. AWS's own guidance is that retrying without the suffix
after an unrelated failure could create an unintended *second* role instead
of fixing the original problem — investigate the failure first.

## Rollback

Service-linked roles cannot be deleted with a plain `DeleteRole` call — it
throws `UnmodifiableEntity`. Rollback instead calls
`DeleteServiceLinkedRole`, then polls `GetServiceLinkedRoleDeletionStatus`
(every ~5s, up to ~2 minutes) until the deletion task reports `SUCCEEDED` or
`FAILED`. A `FAILED` result's reason — naming the in-service resources
blocking deletion — is surfaced as a loud warning. Rollback never throws:
it warns and moves on, so it never masks the original failure that triggered
it. If the poll times out, it also just warns — deletion can be genuinely
slow, and manual follow-up with the logged deletion-task ID is expected.
