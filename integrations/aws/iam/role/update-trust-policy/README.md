# `aws/iam/role/update-trust-policy`

Reconciles a role's trust policy (`AssumeRolePolicyDocument`) to an exact
desired document on a role that already exists. Does not create the role;
run `aws/iam/role/create-role` first if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/iam/role/update-trust-policy --dry-run
bun run bin/ferry.ts aws/iam/role/update-trust-policy
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-role-exists` | aborts in the plan phase if the role doesn't exist |
| `trust-policy` | always reconciles — reads the current document, structurally compares it against `TRUST_POLICY`, and replaces it only if different |
| `verify` | re-reads the trust policy and structurally confirms it matches |

## Gotchas

**This is a whole-document replace.** `UpdateAssumeRolePolicy` has no "add
one trust statement" API — `TRUST_POLICY` must be the complete desired
document every time, not a delta to apply on top of whatever is already
there.

**Re-running with the same document is a true no-op.** The step reads the
current document, structurally compares it (key order and incidental
whitespace ignored, since IAM may reformat either on read-back) against
`TRUST_POLICY`, and makes zero additional AWS API calls if they already
match — no `UpdateAssumeRolePolicy` call is issued.

**Rollback restores the exact prior document.** Unlike a bucket policy, a
role's trust policy is required at creation — `GetRole` always returns a
real `AssumeRolePolicyDocument` — so there is no "never configured" case to
special-case; rollback is always a straightforward re-`Update` of the
captured prior document, and only happens if this run actually changed
something.
