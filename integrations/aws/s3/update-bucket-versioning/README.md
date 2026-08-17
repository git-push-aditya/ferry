# `aws/s3/update-bucket-versioning`

Sets an existing bucket's versioning explicitly — `Enabled` or `Suspended`.
Does not create the bucket; run `aws/s3/create-bucket` first if it doesn't
exist yet.

```bash
bun run bin/ferry.ts aws/s3/update-bucket-versioning --dry-run
bun run bin/ferry.ts aws/s3/update-bucket-versioning
```

## What it does

| Step | Notes |
| --- | --- |
| `s3-bucket-exists` | aborts in the plan phase if the bucket doesn't exist or isn't owned by this account |
| `bucket-versioning` | shared with `aws/s3/create-bucket` — always reconciles, since the desired value depends on params |
| `verify` | polls `GetBucketVersioning` until it reads back the desired status |

## Gotchas

**There is no going back to "never configured".** Once versioning has ever
been touched, S3 offers `Enabled`/`Suspended` only. Rollback of a first-time
`Suspended` set restores that "never configured" best-effort as `Suspended`,
with a logged warning — same limitation `aws/s3/create-bucket` documents for
its own opt-in toggle.

**Re-running with the same `.env` is a safe no-op.** The underlying
`PutBucketVersioning` call is naturally idempotent; setting the same status
again does nothing observable.
