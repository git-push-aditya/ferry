# `snowflake/offboard-developer`

Offboards a departed developer from the Snowflake account the root `.env`
currently points at: revokes every role currently granted, then either
disables the user (default) or drops it outright (opt-in).

```bash
bun run bin/ferry.ts snowflake/offboard-developer --dry-run
bun run bin/ferry.ts snowflake/offboard-developer
```

## Default is disable, not drop

Per this project's general preference for reversible operations, the
default path is:

```sql
ALTER USER <username> SET DISABLED = TRUE;
```

This immediately blocks login and aborts any running/scheduled sessions for
the user — but it does **not** delete the account, its ownership of any
objects, its query history, or its historical grants. It is fully
reversible: `rollback()` (or a manual `ALTER USER ... SET DISABLED = FALSE`
plus re-granting the roles captured in the report) restores the user to
exactly the state it was in before this run.

`DROP USER` is only ever taken when `HARD_DELETE=true` is **explicitly**
set in this folder's `.env`. This is irreversible — Snowflake has no
`UNDROP` for users, and a dropped user must be recreated from scratch with
none of its prior identity, ownership records, or query history preserved.
Leave `HARD_DELETE` unset (or `false`) unless you specifically mean to
permanently destroy the account.

## What it does

| Step | Notes |
| --- | --- |
| `snowflake-connect` | opens the shared connection and self-checks it |
| `offboard-developer` | inverted create-or-skip: a user that's already gone is the clean, skippable state; a present user still needs offboarding — captures granted roles, revokes each, then disables (default) or drops (opt-in) |
| `verify` | disable path: `DESC USER` confirms `DISABLED = TRUE` and no role grants remain. Hard-delete path: the user no longer shows up at all |

## Rollback

- **Disable path**: fully reversible. `rollback()` re-enables the user
  (`SET DISABLED = FALSE`) and re-grants every role that was captured
  before the revoke loop ran.
- **Hard-delete path**: rollback **cannot** undo it. Per Snowflake's own
  documentation a dropped user cannot be recovered. `rollback()` for this
  branch makes no API calls and logs a loud warning instead of pretending a
  recreated shell is equivalent to the original.

## `OFFBOARD_REASON`

Optional, free-text audit-trail metadata (e.g. "resigned 2026-08-10",
"contract ended"). It is **never** passed to any SQL statement — it exists
purely so the generated report records why the offboarding happened
alongside what was torn down.

## Single-account scope

This integration touches whichever Snowflake account the root `.env`'s
`SNOWFLAKE_ACCOUNT` (and matching admin credentials) point at when it runs
— there is no `SF_SCOPE`/staging-vs-prod parameter here. To offboard a
developer from both staging and prod, run this integration twice: once with
staging's root `.env` active, once with prod's. This mirrors the same
"operational, not parameterized" resolution used by
`onboard-developer-staging` / `onboard-developer-prod`.

## Params

| Param | Default | Notes |
| --- | --- | --- |
| `USER_NAME` | — | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen |
| `HARD_DELETE` | `false` | opt-in only; irreversible `DROP USER` when `true` |
| `OFFBOARD_REASON` | (none) | optional; audit-trail metadata for the report only |
