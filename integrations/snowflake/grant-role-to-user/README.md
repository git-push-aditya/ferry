# `snowflake/grant-role-to-user`

Grants an existing Snowflake role to an existing Snowflake user.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it creates

| Step | Resource |
| --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it |
| `snowflake-role-grant` | `GRANT ROLE <role> TO USER <user>` |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. The Snowflake identity needs
privilege to grant the role (in practice `SECURITYADMIN` or `ACCOUNTADMIN`, or
ownership of the role).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, **no hyphen** |
| `ROLE_NAME` | same rule |

## Preconditions — this integration operates on existing objects only

**Both the user and the role must already exist.** This integration does not
create either one — it mirrors how the AWS IAM role/policy integrations
document their own "operates on an existing X" preconditions. If either is
missing, the `GRANT ROLE ... TO USER ...` statement itself fails with a clear
Snowflake error naming the missing object; that failure mode is treated as
acceptable here rather than adding extra guard steps. Use
`snowflake/create-role` first if the role doesn't exist yet.

## Reuses vs creates

- **Grant — created if missing, skipped if already granted.** `check()` reads
  `SHOW GRANTS TO USER` and looks for the role by name.
- **Rollback revokes only what this run granted.** A grant that pre-existed
  before this run is never revoked on rollback.

## Gotchas

**`GRANT ROLE` is naturally idempotent.** Re-granting an already-granted role
is a safe no-op in Snowflake; `check()` still gates the call the same
defensive way every other attach-style step in this project does, so the plan
phase reports `[create]` only when there's actually something to do.

**Hyphens in Snowflake names.** `USER_NAME` and `ROLE_NAME` are unquoted
identifiers, so Snowflake's parser reads `a-b` as subtraction, not a name.
Rejected at validation time.
