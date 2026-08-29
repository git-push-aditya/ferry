# `github/cloudformation-deploy-role-for-actions`

A deliberate two-role split for CloudFormation deploys from CI, not a
single broad role: a narrow CI role (OIDC-trusted, what GitHub Actions
actually assumes) that can only call `cloudformation:*` and `iam:PassRole`
— nothing else — plus a separate CloudFormation execution role (trusted by
`cloudformation.amazonaws.com`, not GitHub) that holds the actual
resource-creation permissions CloudFormation needs mid-deploy. This split
exists so a compromised or over-broad CI token can't directly create
arbitrary AWS resources — it can only ask CloudFormation to, and
CloudFormation's own execution role is the real permission boundary.

```bash
bun run bin/ferry.ts github/cloudformation-deploy-role-for-actions --dry-run
bun run bin/ferry.ts github/cloudformation-deploy-role-for-actions
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-role-exists` | (guard) confirms `AWS_ROLE_NAME` already exists | conflict if it doesn't — run `github/setup-github-actions-oidc-role` first |
| `execution-role` | the CloudFormation execution role | create-or-skip; rollback gated behind `ALLOW_DESTRUCTIVE_ROLLBACK` |
| `execution-role-policies` | the execution role's managed-policy attachments | always-reconcile to exactly `EXECUTION_POLICY_ARNS` |
| `inline-policy` | the CI role's scoped `cloudformation:*` + `iam:PassRole` policy | always-reconcile, whole-document-replace |
| `verify` | re-reads both roles | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`: `AWS_ROLE_NAME` (the
already-provisioned OIDC role), `CFN_EXECUTION_ROLE_NAME`,
`EXECUTION_POLICY_ARNS`, `STACK_NAME_PREFIX`, `ALLOW_DESTRUCTIVE_ROLLBACK`.

## Gotchas

**`iam:PassRole` is the whole point of this task.** It's the single most
commonly *missing* permission in hand-rolled CI roles — teams grant
`cloudformation:*` and then hit `AccessDenied: not authorized to perform
iam:PassRole` at deploy time. This integration always includes it, scoped
to the execution role's exact ARN and gated on `iam:PassedToService ==
cloudformation.amazonaws.com` so the CI role can never hand this role to
any other service.

**No generic minimal policy for the execution role.** What a CloudFormation
stack needs to create depends entirely on what it deploys — there is no
universal minimal set. `EXECUTION_POLICY_ARNS` takes whatever managed
policies fit your stacks; this integration does not invent one, on
purpose, rather than presenting a false sense of least-privilege.

**No generic Terraform/CDK variant.** Those tools' permission needs are
open-ended by nature (whatever the code manages), so there's no clean
minimal-policy story the way CloudFormation's role-delegation model
provides. A Terraform-specific task would need a permissions boundary +
tag-based conditions instead — a meaningfully different, weaker fit for
this project's idempotent `check()` model — and is out of scope here.

**Execution role deletion is gated behind `ALLOW_DESTRUCTIVE_ROLLBACK`,
even for a role this run created.** A real deploy may already reference
the execution role by the time something later in the same run fails and
triggers rollback — deleting it then is a stronger claim than "undo what
we just did," so it defaults to a warn-and-leave-in-place stance instead.
