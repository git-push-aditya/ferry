# `aws/iam/role/tag-role`

Sets a role's tags to an exact desired set on a role that already exists.
Does not create the role; run `aws/iam/role/create-role` first if it doesn't
exist yet.

```bash
bun run bin/ferry.ts aws/iam/role/tag-role --dry-run
bun run bin/ferry.ts aws/iam/role/tag-role
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-role-exists` | aborts in the plan phase if the role doesn't exist |
| `role-tags` | always reconciles — the desired set depends on `TAGS_JSON` |
| `verify` | reads the role's tags back and confirms every desired pair is present |

## Gotchas

**`TagRole` merges, it does not replace.** Unlike S3's `PutBucketTagging`,
AWS's own docs say a `TagRole` call "overwrites" only the keys you send —
tags on the role that this integration doesn't mention are left alone. That
also means there is no `{}`-clears-everything sentinel the way
`aws/s3/tag-bucket` has: clearing specific tags on a role is `UntagRole`'s
job, out of scope here.

**Leaving `TAGS_JSON` empty means "don't touch tags at all".** Set it to a
real JSON object to have this integration converge the role's tags toward it
(existing tags not mentioned are left untouched, by `TagRole`'s own
semantics, not by anything this integration does).

**Rollback restores the pre-run snapshot exactly.** Keys this run introduced
are stripped with `UntagRole`; keys this run overwrote have their prior value
restored with `TagRole`. Both use the tag set captured at the start of this
run — never a guess.
