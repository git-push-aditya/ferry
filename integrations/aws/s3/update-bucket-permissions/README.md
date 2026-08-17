# `aws/s3/update-bucket-permissions`

Reconciles bucket policy and public-access-block on a bucket that already
exists. Does not create the bucket; run `aws/s3/create-bucket` first if it
doesn't exist yet.

```bash
bun run bin/ferry.ts aws/s3/update-bucket-permissions --dry-run
bun run bin/ferry.ts aws/s3/update-bucket-permissions
```

## What it does

| Step | Notes |
| --- | --- |
| `s3-bucket-exists` | aborts in the plan phase if the bucket doesn't exist or isn't owned by this account |
| `bucket-policy` | shared with future policy-touching integrations — leave `BUCKET_POLICY_JSON` empty to leave the bucket's policy untouched |
| `bucket-public-access-block` | shared with `aws/s3/create-bucket` — always reconciled, defaults to blocking |
| `verify` | confirms the stored policy matches the desired document, and confirms public-access-block live |

## Gotchas

**ACLs are out of scope.** AWS has been steering buckets away from ACLs since
2023 (the "Bucket owner enforced" ownership setting disables them by
default). This integration manages bucket policy and public-access-block
only — a bucket that genuinely still needs ACL management is an edge case
this does not cover.

**Public-access-block is applied after the policy, deliberately.** A
permissive policy applied after public-access-block can be made inert by it;
reconciling policy first and PAB second means `BLOCK_PUBLIC_ACCESS` always
wins, which is the safer failure mode.

**Verification of the policy is a config round-trip, not a live access
check.** Confirming a specific principal actually gets the access the policy
implies would need an assume-role probe with a target identity this
integration isn't given — that gap is stated in the report, not hidden.
