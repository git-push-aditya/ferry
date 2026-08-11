# `snowflake/create-storage-s3-integration`

Lets Snowflake write query results to S3 as CSV through an external stage, and
proves it by actually doing so.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it creates

| Step | Resource | Artifact |
| --- | --- | --- |
| `s3-bucket` | S3 bucket (**shared** — see below) | — |
| `s3-prefix-marker` | zero-byte object at the prefix | — |
| `iam-policy` | IAM policy: `GetBucketLocation`/`ListBucket` on the bucket, `Get`/`Put`/`DeleteObject` on the prefix | A |
| `iam-role` | IAM role with a **placeholder** trust policy (account root) | B |
| `attach-policy` | policy → role attachment, then the IAM propagation wait | — |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | — |
| `storage-integration` | Snowflake `STORAGE INTEGRATION` | D |
| `desc-integration` | nothing — reads `STORAGE_AWS_IAM_USER_ARN` + `STORAGE_AWS_EXTERNAL_ID` | E |
| `trust-policy` | **patches** the role's trust policy to Snowflake's real principal + external id | C |
| `stage` | Snowflake external `STAGE` | F |
| `verify` | a `COPY INTO` that lands a CSV in S3, then deletes it | G |

## What it needs

**Root `.env`** — `credentials: ["aws", "snowflake"]`. The AWS identity needs IAM
write access; `SNOWFLAKE_ROLE` must be able to `CREATE INTEGRATION` (in practice
`ACCOUNTADMIN`).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `EXPORT_S3_BUCKET` | bare name, no `s3://`, no trailing slash |
| `EXPORT_S3_PREFIX` | must end with `/` |
| `SF_STORAGE_INTEGRATION_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, **no hyphen** |
| `SF_STAGE_NAME` | same rule |
| `AWS_STORAGE_ROLE_NAME` | plain AWS name, hyphens fine |
| `AWS_STORAGE_POLICY_NAME` | plain AWS name, hyphens fine |

## Reuses vs creates

- **Bucket — reused if it exists.** The step lives in `src/providers/aws/s3.ts`
  because it is generic shared provider logic. This integration does **not** own
  the bucket: if it already exists and belongs to your account, it is reused and
  **no rollback is registered for it**. Only the run that actually creates the
  bucket may delete it.
- **IAM policy / role / attachment — created if missing, skipped if present.** An
  attachment that was already in place is never detached on rollback.
- **Storage integration — created if missing, otherwise re-pointed.** On the
  re-point path the prior `STORAGE_AWS_ROLE_ARN` and `STORAGE_ALLOWED_LOCATIONS`
  are captured first, so rollback restores them instead of dropping an
  integration this run didn't create.
- **Trust policy — always patched.** The prior document is captured and restored
  on rollback.
- **Stage — created if missing, skipped if present.**

## Gotchas

**The step order encodes a circular dependency. Do not rearrange it.**
The role's trust policy needs Snowflake's IAM user ARN and external id, but those
don't exist until the storage integration is created — and Snowflake won't create
one without a role ARN. Hence: role with a throwaway trust policy → integration →
`DESC INTEGRATION` → patch the trust policy. Getting this order wrong is what made
the manual runbook error-prone. See `steps/trust-policy.ts`.

**Never `CREATE OR REPLACE STORAGE INTEGRATION`.** Replacing it regenerates the
external id, which silently invalidates the IAM trust policy built around the old
one. The failure surfaces much later as an unrelated-looking Access Denied. The
step uses `CREATE ... IF NOT EXISTS` + `ALTER ... SET`, and a test pins that.

**Hyphens in Snowflake names.** `SF_STORAGE_INTEGRATION_NAME` and `SF_STAGE_NAME`
are unquoted identifiers, so Snowflake's parser reads `a-b` as subtraction, not a
name. Rejected at validation time.

**`SHOW ... LIKE` treats `_` as a wildcard.** Our names are full of underscores, so
row count alone would report a near-miss name as "already exists" and skip
registering rollback. `showMatchesExactly` compares the returned name.

**First runs are slow on purpose.** Expect 35–60s in the IAM propagation waits,
plus up to ~90s of `COPY` retry/backoff if the trust policy is still settling.
Both waits are skipped when nothing was newly created.

**Bucket ownership in production.** By default this integration creates the bucket
if it's missing. If your prod bucket is provisioned by Terraform or a platform
team, that's already handled — a bucket that exists is reused untouched. A bucket
name owned by a *different* AWS account returns 403, which aborts the run in the
plan phase rather than failing halfway.

**The external id is masked in the report.** Read the real value from
`DESC INTEGRATION <name>` in Snowflake if you need it.
