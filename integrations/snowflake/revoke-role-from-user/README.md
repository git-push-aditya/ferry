# `snowflake/revoke-role-from-user`

Revokes a role grant from a Snowflake user. Safe and idempotent even if the
grant, the role, or the user itself is already gone.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it does

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | |
| `revoke-role-from-user` | `snowflake_role_grant` (revoked) | inverted check: `exists` means already-not-granted (skip); `missing` means the revoke still needs to happen |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`; `SNOWFLAKE_ROLE` must have
privilege to manage grants on the target user (in practice `SECURITYADMIN` or
`ACCOUNTADMIN`).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen |
| `ROLE_NAME` | same rule |

## Idempotency and safety

- **Already revoked / never granted — a no-op.** `check()` reads
  `SHOW GRANTS TO USER` first; if the role isn't there, this reports `exists`
  (the already-achieved target state) and nothing runs.
- **User doesn't exist — also a no-op.** `SHOW GRANTS TO USER` errors "does not
  exist or not authorized" for a nonexistent user; that's caught and treated
  the same as "nothing to revoke" — a nonexistent user trivially has no grant
  to lose. This matters because this step is routinely run during
  offboarding, sometimes after the user was already dropped.
- **Rollback restores exactly what this run removed.** A role grant carries no
  other state, so rollback is just re-`GRANT`ing it — but only if this run's
  own revoke actually happened; a grant that was already absent before this
  run is never touched on rollback.

## Gotchas

**Inverted check().** Unlike most Ferry steps, `exists` here means "the
destructive goal is already achieved" (nothing to revoke), and `missing` means
"the action still needs to happen." This mirrors the plan's stated convention
for revoke/drop/disable-shaped tasks.
