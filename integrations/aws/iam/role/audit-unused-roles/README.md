# `aws/iam/role/audit-unused-roles`

Read-only audit of every IAM role in the account: classifies each as never
used, a stale candidate, or active, using `RoleLastUsed` — free with every
`ListRoles` call — as the default signal, with an optional deeper
Access Advisor pass for candidates only.

**This integration makes no AWS mutations.** There is nothing to roll back —
`rollback()` is a no-op and no `resource()` is ever registered. The whole
point of this integration is the report `report()` produces.

```bash
bun run bin/ferry.ts aws/iam/role/audit-unused-roles --dry-run
bun run bin/ferry.ts aws/iam/role/audit-unused-roles
```

## What it does

| Step | Notes |
| --- | --- |
| `audit-unused-roles` | always re-audits fresh — `check()` always returns `"missing"`, so `create()` (the actual read-and-classify work) runs every time |
| `verify` | asserts the report was actually produced and is well-formed — there is no AWS-side mutation to prove instead |

## `RoleLastUsed` vs. Access Advisor — the honest tradeoff

- **`RoleLastUsed`** (the default signal) comes back on every `ListRoles`
  call at no extra cost. It reports a single "last used, in any capacity,
  anywhere" timestamp, tracked for a trailing window of up to 400 days
  (shorter in newer AWS Regions). A role with no `LastUsedDate` may be
  genuinely unused, or may simply predate that Region's tracking window.
- **Access Advisor** (`RUN_DEEP_ACCESS_ADVISOR_PASS=true`) is strictly
  finer-grained: it lists every AWS service the role's permissions could
  reach and, per service, whether it was ever actually accessed. This can
  reveal a role that was "used" for one trivial permission and is otherwise
  dead weight — something `RoleLastUsed` alone cannot show.
- **Cost/latency**: Access Advisor is an async job per role
  (`GenerateServiceLastAccessedDetails` → poll
  `GetServiceLastAccessedDetails`), so it only runs against roles already
  flagged as candidates by the cheap `RoleLastUsed` pass — never
  unconditionally across every role in the account. Each job is polled for up
  to 60 seconds; a `FAILED` job or a timeout is recorded as "detail
  unavailable" for that role only, and never aborts the rest of the audit.

Treat `STALE_THRESHOLD_DAYS` as a policy choice you set, not an
AWS-recommended default — "unused" is inherently fuzzy, and this integration
does not pretend otherwise.

## Params

| Param | Default | Notes |
| --- | --- | --- |
| `STALE_THRESHOLD_DAYS` | `90` | age past which a used-but-old role is a "stale candidate" |
| `INCLUDE_SERVICE_LINKED_ROLES` | `false` | AWS-managed roles (`Path` under `/aws-service-role/` or `/service-role/`) are excluded by default |
| `RUN_DEEP_ACCESS_ADVISOR_PASS` | `false` | opt-in; only runs against candidates, never every role |
| `PATH_PREFIX_FILTER` | (none) | optional; scopes the audit to roles under a given path |
