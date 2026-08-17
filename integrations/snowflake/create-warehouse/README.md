# `snowflake/create-warehouse`

Creates a Snowflake warehouse with a given size and auto-suspend/resume
policy, and proves it exists with the requested settings.

```bash
bun bin/ferry.ts snowflake/create-warehouse -- --dry-run
bun bin/ferry.ts snowflake/create-warehouse
```

## What it creates

| Step | Resource |
| --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it |
| `warehouse` | Snowflake `WAREHOUSE` |
| `verify` | confirms size/auto_suspend/auto_resume match what was requested |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. `SNOWFLAKE_ROLE` must be able
to `CREATE WAREHOUSE`.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `WAREHOUSE_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, **no hyphen** |
| `WAREHOUSE_SIZE` | one of XSMALL, SMALL, MEDIUM, LARGE, XLARGE, XXLARGE, XXXLARGE, X4LARGE, X5LARGE, X6LARGE; default `XSMALL` |
| `AUTO_SUSPEND_SECONDS` | seconds of inactivity before auto-suspend; default `60` |
| `AUTO_RESUME` | `true`/`false`; default `true` |

## Reuses vs creates

**Warehouse — created if missing, left untouched if it already exists.**
`CREATE WAREHOUSE IF NOT EXISTS` makes repeated runs safe. A warehouse that
already exists under this name is **not** resized or reconfigured by this
integration, even if its current size/auto-suspend differs from what's
requested here — that's deliberately `update-warehouse-size`'s job, not an
implicit side effect of re-running `create-warehouse`. This avoids a
`create-warehouse` re-run silently resizing a production warehouse another
team is actively tuning. Rollback only drops the warehouse when this run is
the one that created it.

## Gotchas

**Created initially suspended.** `INITIALLY_SUSPENDED = TRUE` is a deliberate
default, not an oversight: a freshly created warehouse should not start
burning credits before anything is actually scheduled to run against it. It
resumes automatically on the first query if `AUTO_RESUME=true` (the default).

**Hyphens in Snowflake names.** `WAREHOUSE_NAME` is an unquoted identifier, so
Snowflake's parser reads `a-b` as subtraction, not a name. Rejected at
validation time.

**`SHOW ... LIKE` treats `_` as a wildcard.** `warehouseState` compares the
returned name exactly, so a near-miss underscore-heavy name is never
mistaken for "already exists".
