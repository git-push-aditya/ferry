# `snowflake/add-public-key-to-existing-user`

Attaches an additional RSA public key to an already-provisioned Snowflake
user, for the lead to run with their elevated role. This is the "use the
second slot" half of Snowflake's two-slot key mechanism, usable standalone —
for a full zero-downtime rotation of an *existing* key, use
`snowflake/rotate-user-key-pair` instead.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## What it does

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | |
| `add-public-key` | `snowflake_user_public_key` | sets `RSA_PUBLIC_KEY` or `RSA_PUBLIC_KEY_2` on the user |

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`; `SNOWFLAKE_ROLE` must have
privilege to `ALTER USER` on the target (in practice `SECURITYADMIN` or
`ACCOUNTADMIN`).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen. Must already exist. |
| `PUBLIC_KEY` | Full PEM block or bare base64 — PEM armor/whitespace is stripped before use. |
| `TARGET_SLOT` | optional, `"1"` or `"2"` — see slot selection below. |

## Slot selection

Snowflake gives each user exactly two RSA public-key property slots,
`RSA_PUBLIC_KEY` and `RSA_PUBLIC_KEY_2`. `DESC USER` doesn't echo the raw key
back, only its fingerprint (`RSA_PUBLIC_KEY_FP` / `RSA_PUBLIC_KEY_2_FP`), so
occupancy is determined from the fingerprint being present, not from
comparing key material.

- **`TARGET_SLOT` unset (default)** — auto-detects the first empty slot,
  checking `RSA_PUBLIC_KEY` first, then `RSA_PUBLIC_KEY_2`. This covers both
  "this is the very first key for the user" and "attach an additional key
  alongside an existing one."
- **Both slots already occupied, `TARGET_SLOT` unset** — `conflict`. Silently
  overwriting a key that might still be in active use is exactly the mistake
  `rotate-user-key-pair` exists to do deliberately instead of as a side
  effect here. Re-run with `TARGET_SLOT` set, or use the rotation integration.
- **`TARGET_SLOT` set** — always wins, even if it means overwriting an
  occupied slot.

## Idempotency and safety

- Re-running with the same key against the same slot is a no-op `SET` to the
  same value.
- `rollback()` only `UNSET`s the slot if this run actually set it — a slot
  this run merely found already-occupied (an explicit `TARGET_SLOT` override)
  is not restored to its prior key material, since Ferry never captured it
  (only the fingerprint is ever readable back from Snowflake).

## Gotchas

**This task never creates a user.** `check()` returns `conflict` if
`USER_NAME` doesn't exist — run an onboarding integration first.

**Fingerprint-only visibility.** Because `DESC USER` never echoes the raw
key, this integration cannot detect "the target slot already holds exactly
this key" — it always proceeds to `SET`, relying on Snowflake's own
idempotent behavior for an identical value.
