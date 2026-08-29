# snowflake/set-user-roles

Converges a Snowflake user's granted roles to a desired set, and optionally
sets their default role.

```bash
bun run ferry snowflake/set-user-roles -- --dry-run
bun run ferry snowflake/set-user-roles
```

## Why one integration and not three

This replaces `grant-role-to-user`, `revoke-role-from-user` and
`update-user-role`. Those asked the same lifecycle question three ways — *which
roles should this user hold, and which is their default?* — as imperative
verbs, and each was idempotent only with respect to its own verb.

Stated as a desired set, all three become one call:

| Situation | Params |
| --- | --- |
| Onboard | `ROLES=["ANALYST"]` `DEFAULT_ROLE=ANALYST` |
| Role change | `ROLES=["ENGINEER"]` `PRUNE_UNMANAGED_ROLES=true` `DEFAULT_ROLE=ENGINEER` |
| Offboard | `ROLES=[]` `PRUNE_UNMANAGED_ROLES=true` |

and re-running any of them is a genuine no-op, because the diff comes out
empty. `GRANT` and `REVOKE` as standalone integrations never gave us that.

## Steps

| Step | Behavior |
| --- | --- |
| `snowflake-connect` | connection check; lives in `check()` so `--dry-run` validates credentials for real |
| `user-roles` | diffs live grants against `ROLES`; grants the additions, and revokes the extras when `PRUNE_UNMANAGED_ROLES=true` |
| `default-role` | optional always-reconcile; skipped entirely when `DEFAULT_ROLE` is unset |
| `verify` | re-reads `SHOW GRANTS TO USER` and confirms the set converged |

## Gotchas

**`PRUNE_UNMANAGED_ROLES` defaults to `false`, deliberately.** The common case
is granting, and a tool that silently removes access someone granted by hand
is a tool nobody trusts twice. Pruning is opt-in per run.

**`DEFAULT_ROLE` must appear in `ROLES`.** Enforced in `params.ts` at
validation time, before any API call. Setting a default role the user does not
hold leaves them with a session that cannot assume its own default — a
confusing failure that surfaces much later.

**Ordering is load-bearing.** `default-role` runs after `user-roles` so the
grant is guaranteed to exist before the `ALTER USER ... SET DEFAULT_ROLE`.
Do not reorder them.

**Rollback restores this run's delta only.** It revokes exactly what this run
granted and re-grants exactly what this run revoked — recorded in
`ctx.outputs` at apply time. Roles the user already held are never touched.

**A missing user is a `conflict`, not a create.** This integration converges an
existing user's roles; it does not create users.
