# `snowflake/rotate-user-key-pair`

Genuinely zero-downtime RSA key rotation for a Snowflake user, using
Snowflake's two RSA key property slots (`RSA_PUBLIC_KEY` / `RSA_PUBLIC_KEY_2`)
— by convention, slot 1 holds the current/old key and slot 2 receives the
new one. This is a **two-phase, human-gated** integration: run it once to
mint the new key, migrate connections, then run it again with
`CONFIRM_CUTOVER=true` to retire the old key.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration                    # phase A: mint the new key
# ... migrate every configured connection to the new key, confirm they work ...
CONFIRM_CUTOVER=true bun run setup:integration  # phase B: retire the old key
```

## What it does

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | |
| `mint-new-key` | `snowflake_user_public_key` (phase: mint) | sets the new key into whichever slot is unoccupied (slot 2, normally) |
| `cutover-old-key` | `snowflake_user_public_key` (phase: cutover) | human-gated: only acts when `CONFIRM_CUTOVER=true`, and clears the old key's slot |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`; `SNOWFLAKE_ROLE` must have
privilege to `ALTER USER` on the target (in practice `SECURITYADMIN` or
`ACCOUNTADMIN`).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen. Must already exist. |
| `NEW_PUBLIC_KEY` | Full PEM block or bare base64 — PEM armor/whitespace is stripped before use. |
| `CONFIRM_CUTOVER` | `"true"`/`"false"`, default `"false"`. Gates phase B. |

## The two-phase design

This mirrors the same mint-then-cutover shape as this repo's AWS
access-key rotation, adapted to Snowflake's mechanism:

1. **Mint (`mint-new-key`, every run).** Writes `NEW_PUBLIC_KEY` into
   whichever slot is currently empty (slot 1 if the user has no key at all
   yet, otherwise slot 2 by convention). The old key is never touched here —
   any client still authenticating with it keeps working uninterrupted.
   Logs a clear instruction: migrate connections, confirm they work, then
   re-run with `CONFIRM_CUTOVER=true`.
2. **Cutover (`cutover-old-key`, gated).** Only proceeds when
   `CONFIRM_CUTOVER=true` *and* the old key's slot is still occupied.
   Clears it with `ALTER USER ... UNSET RSA_PUBLIC_KEY` (or whichever slot
   held the old key), leaving the new key as the only key on the user.

Both steps are read from a fresh `DESC USER` on every run, so re-running
mid-rotation (new key present, old key still present, `CONFIRM_CUTOVER`
still false) is always safe: phase A is a no-op re-`SET` of the same value,
and phase B simply doesn't run yet.

## Idempotency and safety

- **Phase A is idempotent.** Re-setting the same key into the same slot is a
  harmless no-op `SET`.
- **Phase B only ever runs once.** After the old slot is cleared, `check()`
  sees it already empty and reports `exists` (skip) on any subsequent run.
- **Phase B is irreversible.** `DESC USER` never echoes raw key material,
  only its fingerprint — Ferry has no way to capture the old key before
  clearing it, so `rollback()` can only warn loudly that it cannot be
  restored. This matches this project's established posture on
  irreversible-secret-clearing operations (AWS access-key rotation,
  IAM-user teardown): honest about the limit rather than pretending to undo
  it.

## Gotchas

**This task never creates a user.** `check()` returns `conflict` if
`USER_NAME` doesn't exist.

**Fingerprint-only visibility.** Slot occupancy is always determined from
the `RSA_PUBLIC_KEY_FP` / `RSA_PUBLIC_KEY_2_FP` fingerprint properties being
non-empty, never from comparing raw key material — Snowflake doesn't expose
the latter back through `DESC USER`.

**Don't skip the migration step.** Running with `CONFIRM_CUTOVER=true` on
the very first invocation clears the old key before any client has picked up
the new one — that reintroduces exactly the downtime this integration exists
to avoid. Always confirm connections work on the new key first.

**`add-public-key-to-existing-user` is a different operation.** That
integration attaches an *additional* key to a user and explicitly conflicts
if it finds both slots already full — it defers to this integration for an
actual rotation rather than guessing which slot is safe to overwrite.
