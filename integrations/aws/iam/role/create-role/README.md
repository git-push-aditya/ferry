# `aws/iam/role/create-role`

Creates an IAM role with a given trust policy. The root of the dependency
graph for every other `aws/iam/role/*` task — `attach-policy-to-role`,
`update-trust-policy`, `create-inline-policy-for-role`, `tag-role`, and
friends all assume a role already exists, either from a prior run of this
integration or from a role provisioned outside Ferry.

```bash
bun run bin/ferry.ts aws/iam/role/create-role --dry-run
bun run bin/ferry.ts aws/iam/role/create-role
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-role` | IAM role | create-or-skip; skipped if a role of this name already exists |
| `verify` | re-reads the trust policy and deep-compares it against what was requested | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `ROLE_NAME` | plain AWS name |
| `TRUST_POLICY` | the full `AssumeRolePolicyDocument`, as JSON text |
| `PATH` | optional, defaults to `/` |
| `DESCRIPTION` | optional |
| `MAX_SESSION_DURATION_SECONDS` | optional, must be in `[3600, 43200]` |
| `PERMISSIONS_BOUNDARY_ARN` | optional |

## Gotchas

**Role names are account-scoped, not globally unique like S3 bucket names.**
Unlike the S3 bucket steps, there is no "exists but isn't ours" third state —
a successful `GetRole` always means this account already owns it, so `check()`
only ever needs `NoSuchEntity` vs. everything else.

**A second run against an existing role name is a clean skip, not an update.**
`CreateRole` throws `EntityAlreadyExists` on a repeat call, so this step never
calls it speculatively — `check()` always gates `create()`. If you need to
change an existing role's trust policy, that's `update-trust-policy`, not a
re-run of this integration.

**Verify rides out eventual consistency, then holds the line.** A trust
policy read immediately after `CreateRole` can briefly still 404 or lag, so
`verify()` polls for a few seconds. If it still doesn't match after the poll
gives up, one final read is taken and a genuine mismatch throws — a `verify()`
failure here still unwinds (deletes) the role that was just created.

**Rollback only ever deletes the role itself.** If this integration is
composed with later steps that attach managed/inline policies, those steps'
own rollbacks detach everything first — the engine's LIFO unwind order
guarantees that — so this step's `rollback()` never needs to know about
attachments it didn't create.
