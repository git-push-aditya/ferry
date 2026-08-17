# `aws/s3/tag-bucket`

Sets a bucket's tags to an exact desired set on a bucket that already exists.
Does not create the bucket; run `aws/s3/create-bucket` first if it doesn't
exist yet.

```bash
bun run bin/ferry.ts aws/s3/tag-bucket --dry-run
bun run bin/ferry.ts aws/s3/tag-bucket
```

## What it does

| Step | Notes |
| --- | --- |
| `s3-bucket-exists` | aborts in the plan phase if the bucket doesn't exist or isn't owned by this account |
| `bucket-tags` | always reconciles — the desired set depends on `TAGS_JSON` |
| `verify` | reads the bucket's tags back and confirms they match exactly |

## Gotchas

**`PutBucketTagging` replaces the whole set.** AWS's own docs say plainly:
"you cannot use this operation to add tags to an existing list." `TAGS_JSON`
must include every tag you want kept, not just the ones changing.

**Leaving `TAGS_JSON` empty means "don't touch tags at all", not "clear
them".** Set it to `{}` explicitly if you want to clear every tag on the
bucket.
