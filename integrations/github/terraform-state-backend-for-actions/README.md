# `github/terraform-state-backend-for-actions`

Provisions a versioned S3 bucket for Terraform/OpenTofu state and grants an
existing GitHub Actions OIDC role scoped access to it — S3-only, no
DynamoDB.

```bash
bun run bin/ferry.ts github/terraform-state-backend-for-actions --dry-run
bun run bin/ferry.ts github/terraform-state-backend-for-actions
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-role-exists` | (guard) confirms `AWS_ROLE_NAME` already exists | conflict if it doesn't — run `github/setup-github-actions-oidc-role` first |
| `s3-bucket` | the state bucket | create-or-skip — reused from `aws/s3/create-bucket`'s own `s3BucketStep` factory |
| `bucket-versioning` | bucket versioning, forced `Enabled` | always-reconcile — the shared `s3VersioningStep` factory |
| `inline-policy` | the CI role's scoped S3 policy | always-reconcile — the shared `iamInlinePolicyStep` factory |
| `verify` | polls versioning + re-reads the policy | — |

Almost entirely composition: every step above is an existing generic
factory. The only integration-specific logic is the backend policy
document in `params.ts`.

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`: `AWS_ROLE_NAME` (the
already-provisioned OIDC role), `S3_BUCKET_NAME`, `STATE_KEY_PREFIX`.

## Gotchas

**No DynamoDB lock table, on purpose.** Terraform 1.10 (November 2024)
added native S3 state locking via `use_lockfile = true` — conditional
writes to a lock file object inside the same bucket — and HashiCorp has
since put the `dynamodb_table` backend option on a deprecation path.
Shipping this integration with a DynamoDB path by default would itself be
the outdated setup this project exists to replace. There is no
`dynamodb.ts` anywhere in this codebase, and this integration does not add
one; a DynamoDB-backed variant is explicitly deferred as a legacy option,
not half-built.

**Confirm the OpenTofu-side flag name before relying on this for OpenTofu
specifically.** `use_lockfile` is Terraform's own flag name; whether
OpenTofu uses the identical name was not independently verified — a
lower-confidence detail worth checking against OpenTofu's own backend docs
before writing this into an OpenTofu-specific runbook.

**Versioning is forced `Enabled`, not configurable.** Terraform's native
locking mechanism assumes it; this integration does not expose a way to
turn it off, unlike the shared `s3VersioningStep`'s own general-purpose
task.

**Bucket rollback follows `aws/s3/create-bucket`'s own convention** — it
only deletes a bucket this run actually created (never a pre-existing
one), and only if it's empty. There is no separate destructive-rollback
flag here, matching that integration's own stance.
