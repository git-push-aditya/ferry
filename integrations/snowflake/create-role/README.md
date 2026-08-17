# `snowflake/create-role`

Creates a Snowflake role, optionally with a starting set of privilege grants.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it creates

| Step | Resource |
| --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it |
| `snowflake-role` | Snowflake `ROLE`, plus any declared `INITIAL_GRANTS` |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. The Snowflake identity needs
`CREATE ROLE` privilege (in practice `SECURITYADMIN` or `ACCOUNTADMIN`), plus
whatever `GRANT` privilege each declared initial grant requires.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `ROLE_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, **no hyphen** |
| `INITIAL_GRANTS` | optional JSON array of `{privilege, onType, onName}` |

## Reuses vs creates

- **Role — created if missing, skipped if present.** Uses
  `CREATE ROLE IF NOT EXISTS`, never `CREATE OR REPLACE` — replacing an
  existing role would silently drop whatever it already had.
- **Initial grants — issued only when the role is created this run.** A role
  that already existed is left untouched; adding grants to an existing role is
  a separate, deliberate task (`grant-database-schema-access`), not an
  implicit side effect of `create-role`.

## Gotchas

**Rollback drops the whole role.** If this run created the role, rollback
issues `DROP ROLE IF EXISTS`, which revokes all its grants atomically — there
is no need to individually revoke the initial grants first. A role that
pre-existed is never rolled back.

**Hyphens in Snowflake names.** `ROLE_NAME` is an unquoted identifier, so
Snowflake's parser reads `a-b` as subtraction, not a name. Rejected at
validation time.

**`INITIAL_GRANTS` is optional.** A bare role with no starting privileges is a
legitimate, common case — e.g. a role meant to be composed later purely via
`GRANT ROLE ... TO ROLE`.
