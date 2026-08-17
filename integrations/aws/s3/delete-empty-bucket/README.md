# `aws/s3/delete-empty-bucket`

Deletes a bucket that has no objects, versions, or delete markers. Aborts in
the plan phase — before touching anything — if the bucket is not empty,
rather than silently emptying it.

```bash
bun run bin/ferry.ts aws/s3/delete-empty-bucket --dry-run
bun run bin/ferry.ts aws/s3/delete-empty-bucket
```

## What it does

`check()` maps the create-or-skip contract onto a delete: the bucket already
being gone is treated as `"exists"` (the target state — deletion — is already
achieved, so a re-run after a successful delete is a clean no-op, not an
error). A present, empty bucket is `"missing"` (the delete still needs to
happen). A present, **non-empty** bucket is `"conflict"` — this integration
never empties a bucket for you.

## Gotchas

**Rollback is best-effort, not a real restore.** Once a bucket is deleted,
its versioning, policy, lifecycle, and tag configuration are gone with no API
to recover them. Rollback recreates an empty bucket of the same name and
region, and logs a loud warning that this is not a full restore.

**Won't touch a non-empty bucket.** If you need to remove data first, use
`aws/s3/delete-bucket-with-transfer` (copy elsewhere in S3) or
`aws/s3/delete-bucket-with-download` (download locally) — both choose
deliberately where the data goes before the bucket itself is deleted.
