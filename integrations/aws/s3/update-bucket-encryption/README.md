# `aws/s3/update-bucket-encryption`

Sets default encryption on a bucket that already exists — `AES256` or
`aws:kms`. Does not create the bucket; run `aws/s3/create-bucket` first if it
doesn't exist yet.

```bash
bun run bin/ferry.ts aws/s3/update-bucket-encryption --dry-run
bun run bin/ferry.ts aws/s3/update-bucket-encryption
```

## What it does

| Step | Notes |
| --- | --- |
| `s3-bucket-exists` | aborts in the plan phase if the bucket doesn't exist or isn't owned by this account |
| `bucket-encryption` | shared with `aws/s3/create-bucket` — always reconciles |
| `verify` | writes a test object and confirms its response reports the desired algorithm |

## Gotchas

**Rollback is exact, unlike versioning.** `DeleteBucketEncryption` cleanly
returns a bucket to AWS's own default SSE-S3 baseline if this run's change is
undone, and restores the prior explicit config exactly if there was one.

**Only affects newly-written objects.** Existing objects keep whatever
encryption they were written with; this integration does not re-encrypt them.
