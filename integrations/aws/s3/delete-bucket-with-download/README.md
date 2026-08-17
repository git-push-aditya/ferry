# `aws/s3/delete-bucket-with-download`

Downloads every object from a source bucket to local disk, confirms each
file's byte size matches, and only then deletes the source bucket. The local-
filesystem sibling of `aws/s3/delete-bucket-with-transfer`.

```bash
bun run bin/ferry.ts aws/s3/delete-bucket-with-download --dry-run
bun run bin/ferry.ts aws/s3/delete-bucket-with-download
```

## What it does

| Step | Notes |
| --- | --- |
| `download-and-delete-source` | downloads every object, confirms byte size on disk, then deletes the source |
| `verify` | confirms every downloaded file is present with the expected size, and the source bucket is gone |

Same hard ordering gate as the transfer sibling: every object is downloaded
and confirmed on disk before the source bucket or any of its objects are
touched.

## Gotchas

**Rollback deletes only the local files this run created — it never touches
AWS.** This is the one integration in the `aws/s3/` set where rollback acts
on the local filesystem instead of an AWS resource.

**Byte-size confirmation, not content hash.** `ETag` isn't a reliable content
hash for multipart-uploaded objects, so this compares downloaded file size
against `ContentLength` rather than trying to verify a checksum.

**`PRESERVE_KEY_PREFIX_STRUCTURE=false` flattens every key into one
filename** (replacing `/` with `_`) instead of recreating the key's prefixes
as real subdirectories.
