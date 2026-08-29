# aws/s3/decommission-bucket

Preserves a bucket's contents, then deletes the bucket — and proves both.

```bash
bun run ferry aws/s3/decommission-bucket -- --dry-run
bun run ferry aws/s3/decommission-bucket
```

## Why one integration and not three

Replaces `delete-empty-bucket`, `delete-bucket-with-download` and
`delete-bucket-with-transfer`. All three were the same teardown — drain,
confirm, delete, verify — differing only in where the contents went.

The drain is a parameter, not an integration. Having it as one means the
invariant that actually matters here is written down once instead of three
times.

| `DRAIN_MODE` | Behavior |
| --- | --- |
| `none` | Refuses at plan time unless the bucket is already empty |
| `download` | Writes every object to `DOWNLOAD_DIR`, confirming each by byte size |
| `transfer` | Copies every object into `DESTINATION_S3_BUCKET_NAME`, confirming each landed |

## Steps

| Step | Behavior |
| --- | --- |
| `decommission-bucket` | drains, confirms, then deletes. Delete-shaped `check()`: an already-absent bucket reads as `exists`, so a re-run is a no-op. |
| `verify` | confirms every preserved object is at its destination, and that the source bucket is gone |

## Gotchas

**The phase ordering is a hard invariant, not best-effort.** Every object is
drained *and confirmed* before the source bucket or any of its objects are
touched. If confirmation fails partway, the run aborts with the source fully
intact. This is the single most important property of this integration — do
not reorder it, and do not make the confirmation conditional.

**Rollback cannot bring the bucket back.** It removes only what this run wrote
elsewhere: local files it downloaded, or keys it copied into the destination.
Never pre-existing destination objects, never the destination bucket (this
integration does not own it), and never the source — because by the time
`create()` can fail partway, the source deletion has not run yet.

**`DRAIN_MODE=none` is a guard, not a drain.** A non-empty bucket is a
`conflict` at plan time, so the run stops before mutating anything rather than
destroying data the caller did not ask to preserve.

**A 403 on the source aborts in the plan phase.** `ensureBucketState` returns
`conflict` — either another account owns the name, or these credentials cannot
read a bucket you do own. Neither is fixed by proceeding.
