# `aws/s3/sync-bucket-contents`

A repeatable, non-destructive one-way sync from a source bucket to a
destination bucket that both already exist. Unlike
`aws/s3/delete-bucket-with-transfer`, the source is never touched and nothing
is ever deleted from the destination — this is meant to be run again and
again.

```bash
bun run bin/ferry.ts aws/s3/sync-bucket-contents --dry-run
bun run bin/ferry.ts aws/s3/sync-bucket-contents
```

## What it does

| Step | Notes |
| --- | --- |
| `source-bucket-exists` / `destination-bucket-exists` | abort in the plan phase if either bucket doesn't exist |
| `sync-objects` | diffs by key + size and copies whatever's missing or mismatched |
| `verify` | re-runs the same diff after syncing and confirms it's now empty |

## Gotchas

**Diffs by key + size, not by content hash.** `ETag` isn't a reliable content
hash for multipart-uploaded objects, so this compares size instead. When in
doubt it re-copies — cheap and idempotent, and safer than risking a false
"already synced".

**Never deletes anything, on either side.** A source object removed since the
last sync stays in the destination forever unless you build a "mirror +
delete extras" variant deliberately — that's a different task with a
different risk profile, not something this one does silently.

**Meant to be re-run.** Each run's diff naturally shrinks to nothing as it
catches up; a fully-synced pair converges to a clean no-op.

**Rollback deletes only what this run copied.** Pre-existing destination
objects are never touched.
