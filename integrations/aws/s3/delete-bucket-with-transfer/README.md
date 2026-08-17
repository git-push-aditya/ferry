# `aws/s3/delete-bucket-with-transfer`

Copies every object from a source bucket into a destination bucket that
already exists, confirms every object landed, and only then deletes the
source bucket (and every object in it).

```bash
bun run bin/ferry.ts aws/s3/delete-bucket-with-transfer --dry-run
bun run bin/ferry.ts aws/s3/delete-bucket-with-transfer
```

## What it does

| Step | Notes |
| --- | --- |
| `destination-bucket-exists` | aborts in the plan phase if the destination doesn't exist — this integration never creates it |
| `transfer-and-delete-source` | copies every object (multipart above 5 GiB), confirms each landed, then deletes the source |
| `verify` | confirms every transferred object is present at the destination and the source bucket is gone |

## The ordering invariant

Every object is copied **and confirmed present** in the destination before
the source bucket or any of its objects are touched. This is a hard gate, not
best-effort: if even one object fails to confirm, the run aborts before
deleting anything on the source side.

## Idempotency

If interrupted partway through, re-running re-lists the remaining source
keys (the source isn't deleted until every key is confirmed) and resumes —
re-copying an already-copied key is a safe, idempotent overwrite. If the
source is already gone (a prior run completed), this reads as `"exists"` — a
clean no-op, not an error.

## Gotchas

**Rollback deletes only what this run copied.** Pre-existing objects already
in the destination bucket are never touched, and the destination bucket
itself is never deleted — this integration doesn't own it.

**Cross-region transfers are allowed but slower.** `CopyObject`/
`UploadPartCopy` work across regions; there's no blocker here, just a cost/
latency tradeoff worth knowing about for large transfers.
