# `aws/s3/enable-bucket-logging`

Enables server access logging on a bucket that already exists, to a target
bucket that also already exists. Does not create either bucket.

```bash
bun run bin/ferry.ts aws/s3/enable-bucket-logging --dry-run
bun run bin/ferry.ts aws/s3/enable-bucket-logging
```

## What it does

| Step | Notes |
| --- | --- |
| `s3-bucket-exists` | aborts in the plan phase if the source bucket doesn't exist |
| `logging-target-bucket-exists` | aborts in the plan phase if the target bucket doesn't exist |
| `bucket-logging` | always reconciles — there is no "leave alone" toggle here, only this integration's whole purpose |
| `verify` | reads the logging config back and confirms it targets the desired bucket/prefix |

## Before you run this

**The target bucket must already grant the S3 log-delivery principal write
permission**, via its own bucket policy — see `aws/s3/update-bucket-permissions`.
AWS accepts `PutBucketLogging` regardless of whether that grant exists, and
silently delivers no logs if it's missing. This integration does not check
for it; get that policy right on the target bucket first.

## Gotchas

**Verification is a config round-trip, not proof logs are flowing.** Log
delivery is best-effort and asynchronous — first logs can take hours per
AWS's own guidance — so `verify()` can only confirm the stored configuration
targets the right place.

**Rollback restores the prior target exactly, or disables logging if there
was none.** The prior `LoggingEnabled` document (or its absence) is captured
before this run's change.
