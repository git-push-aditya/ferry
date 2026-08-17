# `snowflake/update-user-role`

Sets a Snowflake user's `DEFAULT_ROLE` — the role a session assumes
automatically at login — to a role the user already holds.

**This is not "grant a new role."** Granting a role to a user is
`snowflake/grant-role-to-user`. This integration changes an `ALTER USER`
property; it requires the target role to already be granted to the user, and
fails loudly (a real precondition error, not a silent grant) if it isn't.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it does

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | |
| `update-default-role` | `snowflake_user_default_role` | always-reconcile: `check()` compares current `DEFAULT_ROLE` (via `DESC USER`) against the target and reports `exists` if they already match |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`; `SNOWFLAKE_ROLE` must have
privilege to `ALTER USER` on the target user.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen |
| `TARGET_DEFAULT_ROLE` | same rule; must already be granted to `USER_NAME` |

## Idempotency and safety

- **Already set — a no-op.** `check()` reads `DESC USER` first; if
  `DEFAULT_ROLE` already matches the target, nothing runs.
- **Precondition, not a side-grant.** `reconcile()` first checks
  `SHOW GRANTS TO USER` for the target role. If it isn't granted, this throws
  a clear error rather than granting it — that's a different integration's
  job (`snowflake/grant-role-to-user`), run deliberately beforehand.
- **Rollback restores the prior `DEFAULT_ROLE`.** Captured before the
  `ALTER USER` runs; if `reconcile()` never ran (already converged), rollback
  is a no-op.

## Gotchas

**`DEFAULT_ROLE` takes an unquoted identifier, not a string literal.** Unlike
most Snowflake object names embedded via `sqlLiteral`, `SET DEFAULT_ROLE = X`
is written bare — `snowflakeIdentifier` validation already guarantees the
value is safe to embed directly, matching how `storage-integration.ts` embeds
its own identifier params.

**This does not compose the grant.** If `TARGET_DEFAULT_ROLE` isn't already
granted to `USER_NAME`, this integration fails at the precondition check
rather than granting it implicitly — run `snowflake/grant-role-to-user` first.
