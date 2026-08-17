# `aws/ec2/tag-instance`

Reconciles an existing instance's tags against a desired set. Does not
create the instance; run `aws/ec2/launch-instance` first if it doesn't exist
yet.

```bash
bun run bin/ferry.ts aws/ec2/tag-instance --dry-run
bun run bin/ferry.ts aws/ec2/tag-instance
```

## What it does

| Step | Notes |
| --- | --- |
| `instance-tags` | always reconciles — the desired set depends on `TAGS`. `"conflict"` if the instance doesn't exist (this integration never creates one) |
| `verify` | reads the instance's tags back and confirms the desired set is present |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `INSTANCE_ID` | must already exist |
| `TAGS` | JSON object of desired tags, required |
| `PRUNE_UNMANAGED_TAGS` | optional, default `false` |

## Gotchas

**Additive by default, not fully declarative.** Unlike `tag-bucket`'s
`PutBucketTagging` (a true whole-set replace), `CreateTags`/`DeleteTags` let
this step diff rather than PUT the whole set. `PRUNE_UNMANAGED_TAGS=false`
(the default) means this step only ever adds or updates tags listed in
`TAGS` — tags already on the instance but absent from `TAGS` are left alone.
This is deliberate: many tools tag the same instance for different purposes
(reserved `aws:` prefixes, other IaC), and this step should never silently
erase a tag it wasn't told about.

**Set `PRUNE_UNMANAGED_TAGS=true`** to make `TAGS` the full declarative set —
any tag currently on the instance but not listed is removed.

**Rollback restores exactly what was there before.** Every key this run
touches (added, changed, or removed) has its prior value captured before the
change, so rollback puts each one back precisely — keys this run added are
deleted, keys this run changed or removed are restored to their prior value.
