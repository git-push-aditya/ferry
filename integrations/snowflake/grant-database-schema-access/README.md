# `snowflake/grant-database-schema-access`

Converges an existing Snowflake role's privileges on an existing database or
schema to a declared desired set.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it creates

| Step | Resource |
| --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it |
| `grant-access` | `GRANT`/`REVOKE` on the target `DATABASE`/`SCHEMA`, converging to `DESIRED_PRIVILEGES` |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. The Snowflake identity needs
privilege to grant/revoke on the target object (in practice `SECURITYADMIN` or
`ACCOUNTADMIN`, or ownership of the object).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `ROLE_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, **no hyphen** |
| `OBJECT_TYPE` | `DATABASE` or `SCHEMA` |
| `OBJECT_NAME` | the database name, or a schema name — qualify as `database.schema` if it isn't the current session database. Not restricted to a single unquoted identifier the way `ROLE_NAME` is, since a qualified name legitimately contains a `.` |
| `DESIRED_PRIVILEGES` | comma-separated, e.g. `USAGE,SELECT` |
| `PRUNE_UNMANAGED_PRIVILEGES` | `true`/`false`, default `false` |

## Preconditions — this integration operates on existing objects only

**Both the role and the target database/schema must already exist.** This
integration does not create either one. If either is missing, the `GRANT`
statement itself fails with a clear Snowflake error naming the missing
object; that failure mode is treated as acceptable here rather than adding
extra guard steps — the same posture `grant-role-to-user` documents.

## Reuses vs creates

- **Always reconciles.** Granting the same privilege twice is a safe no-op,
  but "the set of privileges this role should have on this object" is
  naturally a diff-and-converge operation, so `check()` always reports
  `missing` and `reconcile()`'s own diff decides whether anything actually
  changes.
- **Additive by default.** `PRUNE_UNMANAGED_PRIVILEGES=false` (the default)
  means privileges the role already holds but that aren't in
  `DESIRED_PRIVILEGES` are left alone — a run never silently takes away
  access it wasn't told about. Set it to `true` to converge to an *exact*
  privilege set, revoking anything not declared.
- **Rollback undoes only what this run executed** — the captured
  grant/revoke lists, not the originally-computed diff, the same "executed,
  not planned" discipline `rotate-role-permissions` uses for AWS IAM.

## Gotchas

**`GRANT`/`REVOKE` are naturally idempotent.** Re-granting an already-held
privilege, or re-revoking one already absent, is a safe no-op in Snowflake.

**Hyphens in `ROLE_NAME`.** It's an unquoted identifier, so Snowflake's
parser reads `a-b` as subtraction, not a name. Rejected at validation time.
`OBJECT_NAME` is deliberately not validated this strictly — see above.

**Pruning is all-or-nothing per run.** With `PRUNE_UNMANAGED_PRIVILEGES=true`,
any privilege this role holds on the object that isn't in
`DESIRED_PRIVILEGES` is revoked, even if some other process granted it
outside this tool. Only turn it on once `DESIRED_PRIVILEGES` is the complete,
intended list.
