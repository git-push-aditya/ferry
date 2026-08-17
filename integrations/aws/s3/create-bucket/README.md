# `aws/s3/create-bucket`

Provisions an S3 bucket with the settings a new bucket most often needs at
creation time — versioning, default encryption, and a public-access block —
each opted into independently, and proven with a live write/read against the
bucket, not just trusted from the API responses that set them.

```bash
bun run bin/ferry.ts aws/s3/create-bucket --dry-run
bun run bin/ferry.ts aws/s3/create-bucket
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `s3-bucket` | S3 bucket (**shared step** — see `create-backend-s3-user`) | Reused if it already exists and is owned by this account |
| `bucket-versioning` | bucket versioning configuration | Only touched if `ENABLE_VERSIONING=true` |
| `bucket-encryption` | default encryption configuration | Only touched if `ENABLE_ENCRYPTION=true` |
| `bucket-public-access-block` | public access block | Always reconciled — defaults to blocking |
| `verify` | writes, reads and deletes a test object; confirms every opted-in setting against the bucket itself | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `S3_BUCKET_NAME` | bare name, no `s3://`, no trailing slash |
| `ENABLE_VERSIONING` | `"true"`/`"false"`, default `false` |
| `ENABLE_ENCRYPTION` | `"true"`/`"false"`, default `false` |
| `ENCRYPTION_ALGORITHM` | `AES256` or `aws:kms`, ignored if encryption isn't enabled |
| `ENCRYPTION_KMS_KEY_ID` | required only when the algorithm is `aws:kms` |
| `BLOCK_PUBLIC_ACCESS` | `"true"`/`"false"`, default `true` |

## Reuses vs creates

- **Bucket — reused if it exists, and this is the common case.** Same shared
  step `create-backend-s3-user` uses. No rollback is registered for a reused
  bucket.
- **Versioning / encryption / public-access-block — always reconciled, not
  create-or-skip.** The desired state depends on this run's params, which
  aren't known at plan time, so — like the Snowflake integration's
  `trust-policy` step — these steps always run and are themselves idempotent:
  re-running with the same `.env` reapplies the same value, which S3 accepts
  as a no-op.

## Gotchas

**`ENABLE_VERSIONING=false` does not suspend existing versioning.** There is
no S3 API to return a bucket to "never configured" once versioning has ever
been touched, so this integration treats "false" as "leave it alone" rather
than forcing a `Suspended` state as a side effect of an unrelated default. If
you want to suspend versioning on a bucket that already has it enabled, that
is a deliberate action this integration does not take for you.

**Versioning rollback is best-effort.** If this run enabled versioning on a
bucket that had never been configured before, rollback restores `Suspended` —
the closest achievable state — and logs a warning that this is not an exact
restore, since no such "unset" state exists to return to.

**Encryption rollback is exact.** Unlike versioning, `DeleteBucketEncryption`
cleanly returns a bucket to AWS's own default baseline, so rollback here is a
full, not best-effort, restore.

**Public access block is not opt-in.** Every run reconciles it (default:
blocking), because a freshly provisioned bucket should not be publicly
reachable by accident. Set `BLOCK_PUBLIC_ACCESS=false` explicitly if you want
a public bucket.

**Verification only proves what was opted into.** If versioning or encryption
were left off, `verify()` does not claim they are configured — it checks the
opted-in settings live against the bucket, and otherwise only proves the
plain write/read/delete path and the public-access-block state (which is
always managed).
