# `snowflake/update-warehouse-size`

Resizes an existing Snowflake warehouse to a target size, and proves it took
effect.

```bash
bun bin/ferry.ts snowflake/update-warehouse-size -- --dry-run
bun bin/ferry.ts snowflake/update-warehouse-size
```

## What it does

| Step | Resource |
| --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it |
| `resize-warehouse` | `ALTER WAREHOUSE ... SET WAREHOUSE_SIZE` (always-reconcile, no create) |
| `verify` | confirms the reported size now equals `TARGET_SIZE` |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. `SNOWFLAKE_ROLE` must be able
to `ALTER WAREHOUSE`.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `WAREHOUSE_NAME` | Snowflake identifier; **must already exist** — this integration never creates one, see `create-warehouse` |
| `TARGET_SIZE` | one of XSMALL, SMALL, MEDIUM, LARGE, XLARGE, XXLARGE, XXXLARGE, X4LARGE, X5LARGE, X6LARGE |

## Reuses vs creates

**Never creates a warehouse.** `check()` reports `conflict` if
`WAREHOUSE_NAME` doesn't exist — that's a real precondition on
`create-warehouse` having run first, not something this integration papers
over.

**Always reconciles.** There's no missing/exists split to plan against: the
desired size depends on `TARGET_SIZE`, so `reconcile()` always runs and
short-circuits to a no-op if the warehouse is already at the target size.
The prior size is captured before the `ALTER` and restored on rollback; a
no-op reconcile never sets it, so rollback has nothing to undo in that case.

## Gotchas

**Non-disruptive resize — this is not the EC2 pattern.** Resizing a
Snowflake warehouse (`ALTER WAREHOUSE ... SET WAREHOUSE_SIZE`) does not
disrupt currently-executing statements: Snowflake re-provisions compute
rather than stopping/starting it in place, so running queries finish on
their existing resources and the new size applies only to statements that
start after the resize completes. This is architecturally different from
resizing an AWS EC2 instance, which requires a stop/start and *is*
disruptive to what's currently running — a reviewer coming from the AWS side
of this codebase should not assume a maintenance-window-style precaution is
needed here.

**Hyphens in Snowflake names.** `WAREHOUSE_NAME` is an unquoted identifier, so
Snowflake's parser reads `a-b` as subtraction, not a name. Rejected at
validation time.
