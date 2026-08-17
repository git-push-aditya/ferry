# `aws/iam/role/create-inline-policy-for-role`

Reconciles a named inline policy on a role that already exists to an exact
desired document. Does not create the role; run `aws/iam/role/create-role`
first if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/iam/role/create-inline-policy-for-role --dry-run
bun run bin/ferry.ts aws/iam/role/create-inline-policy-for-role
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-role-exists` | aborts in the plan phase if the role doesn't exist |
| `inline-policy` | always reconciles — reads any existing document under `POLICY_NAME`, structurally compares it against `POLICY_DOCUMENT`, and replaces it only if different |
| `verify` | re-reads the inline policy document and structurally confirms it matches |

## Gotchas

**This is a whole-document replace, scoped to one policy name.**
`PutRolePolicy` is documented as "adds *or updates*" a named inline policy —
there is no "add one statement" API, so `POLICY_DOCUMENT` must be the
complete desired document for `POLICY_NAME` every time. Other inline
policies on the same role, under other names, are left untouched.

**Re-running with the same name and document is a true no-op.** The step
reads the current document (if any), structurally compares it (key order and
incidental whitespace ignored) against `POLICY_DOCUMENT`, and makes zero
additional AWS API calls if they already match. Re-running with the same
name but a changed document correctly converges to the new document — this
is deliberate "PutRolePolicy is upsert" behavior, not a bug, and is exactly
why this step declares no `create()`.

**Rollback depends on whether the policy existed before this run.** If it
didn't (a fresh create under that name), rollback deletes it entirely. If it
did, rollback restores the exact prior document captured before the change.
A role or policy already removed by something else in the same run is
tolerated — rollback warns rather than crashing the unwind.
