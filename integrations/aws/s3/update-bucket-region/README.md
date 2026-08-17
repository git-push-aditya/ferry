# `aws/s3/update-bucket-region`

S3 has no in-place region migration API. This composes create-new + copy +
verify + delete-old as a flat, ordered step list.

```bash
bun run bin/ferry.ts aws/s3/update-bucket-region --dry-run
bun run bin/ferry.ts aws/s3/update-bucket-region
```

## What it does

| Step | Notes |
| --- | --- |
| `old-bucket-exists` | aborts in the plan phase if the old bucket doesn't exist |
| `s3-bucket` (shared) | creates the new bucket if missing, in whatever region your root `AWS_REGION` credential specifies |
| `migrate-objects` | copies every object (multipart above 5 GiB), confirming each landed — never touches the old bucket |
| `delete-old-bucket` | only runs after every object is confirmed present in the new bucket; deletes the old bucket |
| `verify` | confirms object parity and that the old bucket is gone |

## Setting the target region

There is no `TARGET_REGION` param. The new bucket is created in whatever
region the root `.env`'s `AWS_REGION` credential specifies for this run —
set that to your target region before running.

## Bucket-level settings are not carried over automatically

Versioning, default encryption, public-access-block, bucket policy, and tags
are **not** mirrored onto the new bucket. `CreateBucket`/`CopyObject` don't
copy them, and reading them live off the old bucket to mirror onto the new
one doesn't fit this project's step contract (a step's desired-state
accessors are pure functions of params, not of another step's live-read
outputs). Run these against the new bucket afterward if you need them:

- `aws/s3/update-bucket-versioning`
- `aws/s3/update-bucket-encryption`
- `aws/s3/update-bucket-permissions`
- `aws/s3/tag-bucket`

## The ordering invariant

`migrate-objects` never deletes anything from the old bucket. `delete-old-
bucket` only runs as its own explicit, separately-confirmed step — never
auto-chained into the copy — mirroring `delete-bucket-with-transfer`'s "prove
before the destructive half runs" discipline.

## Gotchas

**Rollback of `delete-old-bucket` is best-effort**, same limitation as
`delete-empty-bucket`: bucket-level configuration on the old bucket cannot be
recovered once deleted.
