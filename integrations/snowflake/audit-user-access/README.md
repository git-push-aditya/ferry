# `snowflake/audit-user-access`

Read-only audit of a Snowflake user's access: every role currently granted,
and for each role, every privilege/object it directly holds
(`SHOW GRANTS TO ROLE`) plus every parent role it's been granted to
(`SHOW GRANTS OF ROLE`, the role-hierarchy view), together with
account-level flags (`DISABLED`, `DEFAULT_ROLE`, whether an RSA key is
registered).

```bash
bun run bin/ferry.ts snowflake/audit-user-access --dry-run
bun run bin/ferry.ts snowflake/audit-user-access
```

**This integration makes no Snowflake mutations.** There is nothing to roll
back — `rollback()` is a no-op and no `resource()` is ever registered. The
whole point of this integration is the report `report()` produces.

## Single-account scope — read this before running it

This integration audits **whichever Snowflake account the root `.env`
currently points at** (via `SNOWFLAKE_ACCOUNT` and its matching
credentials). There is deliberately no `SF_SCOPE`/staging-vs-prod
parameter.

Ferry's credential model loads one Snowflake credential set per provider id
from the root `.env`. Auditing staging **and** prod together in a single
run would require holding two live connections to two entirely different
accounts open simultaneously — a shape the current provider model doesn't
cleanly support (and building dual-connection support for one integration
is out of scope here).

**To audit both staging and prod:** run this integration twice — once with
staging's root `.env` active, once with prod's — and compare the two
reports. This mirrors the same "operational, not parameterized" resolution
already used by `onboard-developer-staging` / `onboard-developer-prod`.

## What it does

| Step | Notes |
| --- | --- |
| `snowflake-connect` | opens the shared connection and self-checks it |
| `audit-user-access` | always re-audits fresh — `check()` always returns `"missing"`, so `create()` (the actual read-and-report work) runs every time |
| `verify` | asserts the report was actually produced and is well-formed — there is no Snowflake-side mutation to prove instead |

## The role-hierarchy walk

`SHOW GRANTS TO ROLE <role>` returns the privileges/objects the role itself
holds. `SHOW GRANTS OF ROLE <role>` returns what the role has been granted
*to* — its parent roles — which is how a role's privileges compose up a
hierarchy. Snowflake role grants can form a DAG rather than a strict tree,
so the walk only visits each distinct role name once (roles are
deduplicated from `SHOW GRANTS TO USER` before auditing), which is
sufficient to avoid infinite recursion for the one-level-deep "parents of
this user's directly-granted roles" picture this integration reports.

## Params

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen |
