# `aws/s3/enable-bucket-lifecycle-rules`

Sets lifecycle rules on a bucket that already exists. Does not create the
bucket; run `aws/s3/create-bucket` first if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/s3/enable-bucket-lifecycle-rules --dry-run
bun run bin/ferry.ts aws/s3/enable-bucket-lifecycle-rules
```

## What it does

| Step | Notes |
| --- | --- |
| `s3-bucket-exists` | aborts in the plan phase if the bucket doesn't exist or isn't owned by this account |
| `bucket-lifecycle` | always reconciles — the desired rule set depends on `LIFECYCLE_RULES_JSON` |
| `verify` | reads the configuration back and confirms it matches the desired set exactly |

## Gotchas

**`PutBucketLifecycleConfiguration` replaces the whole document.** AWS's own
docs: "this will overwrite an existing lifecycle configuration... they must be
included in the new lifecycle configuration." `LIFECYCLE_RULES_JSON` must
include every rule you want kept.

**One step manages every rule, not one step per rule.** All N rules share one
atomic replace/rollback unit by AWS's own API design, so this is modeled as a
single step — a step-factory expanding into N independent steps would be the
wrong shape here (that pattern fits N independently-identified resources,
which these rules are not).

**Run `aws/s3/update-bucket-versioning` first if any rule references
noncurrent versions.** A `NoncurrentVersionExpiration` rule on a
never-versioned bucket is accepted by the API but is a silent no-op.

**Verification is a config round-trip, not a behavior check.** Lifecycle
actions run on AWS's own schedule (roughly daily), not synchronously, so
`verify()` can only confirm the stored configuration matches what was
requested — it cannot prove a rule actually fires. That limitation is stated
in the report rather than hidden.
