# `aws/iam/user/create-user`

Provisions a bare IAM user — no policy, no access key, no group membership.
Root/first step of any chain that provisions a user identity: `create-access-key`,
`attach-policy`, `add-to-group` and similar user-scoped tasks all depend on this
one having run first.

```bash
bun run ferry aws/iam/user/create-user -- --dry-run
bun run ferry aws/iam/user/create-user
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-user` | IAM user | optional `Path` and `PermissionsBoundary` set at creation time |
| `verify` | re-reads the user with `GetUser` | confirms `UserName`, and `Path`/boundary if requested |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `IAM_USER_NAME` | plain AWS name, required |
| `IAM_USER_PATH` | optional, defaults to AWS's own "/" |
| `IAM_PERMISSIONS_BOUNDARY_ARN` | optional; cheapest guardrail against over-broad follow-on policy attachments |

## Reuses vs creates

IAM user names are account-scoped, not globally unique like S3 bucket names —
there is no "exists but isn't ours" third state. A user that already exists is
reused: `check()` reports `"exists"`, `create()` is skipped, and no rollback is
registered for it, so a failed run will never delete a user it did not create.

## Gotchas

**No access key, no policy, no group.** This task only ever creates the bare
user object. Everything else is a separate, composable task — see
`aws/iam/user/create-access-key` for minting the first credential.

**Rollback only ever undoes what this run created.** If the user already
existed, rollback is a no-op for this step (per the engine's own rule: a
resource that already existed is never rolled back).
