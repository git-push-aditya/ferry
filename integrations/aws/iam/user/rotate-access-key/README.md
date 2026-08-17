# `aws/iam/user/rotate-access-key`

Rotates an IAM user's access key **in two explicitly separate, human-gated
runs.** This is not a single atomic operation — AWS's own documented
rotation workflow is: create new key -> update every place the old key's
credentials are configured (a step only a human, or their deployment
pipeline, can perform) -> deactivate old key -> (after a soak, confirming
nothing broke) delete old key. Ferry has no visibility into which downstream
systems were migrated, so it never automates past minting the new key
without an explicit, required confirmation.

## The exact two-phase sequence

**Run 1 — mint (Phase A), automatic, no confirmation needed:**

```bash
bun run ferry aws/iam/user/rotate-access-key -- --dry-run
bun run ferry aws/iam/user/rotate-access-key
```

This mints a second access key on the user (failing loudly if the user has
zero keys — rotation presumes one already exists — or leaving things alone
if it's already mid-rotation with two keys present). The old key is **not
touched at all** in this run. The new key's secret is printed to stdout once.

**You do this manually, outside Ferry:** update every configured credential
(app config, secret store, CI variables, etc.) to use the new key, deploy,
and confirm the application actually works with it.

**Run 2 — cutover (Phase B), only once you set `CONFIRM_CUTOVER=true`:**

```bash
# in this folder's .env:
CONFIRM_CUTOVER=true

bun run ferry aws/iam/user/rotate-access-key -- --dry-run
bun run ferry aws/iam/user/rotate-access-key
```

This deactivates the old key, optionally soaks for `ROTATION_SOAK_MINUTES`,
then **deletes** it. Deletion is irreversible — AWS never returns a deleted
key's secret again.

## What it creates / does

| Step | Resource | Phase |
| --- | --- | --- |
| `mint-new-key` | new access key pair | A — always runs, purely additive |
| `cutover-old-key` | old access key: `Active` -> `Inactive` -> deleted | B — only when `CONFIRM_CUTOVER=true` |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `IAM_USER_NAME` | plain AWS name |
| `CONFIRM_CUTOVER` | `true`/`false`, default `false` — the required manual gate |
| `ROTATION_SOAK_MINUTES` | optional, default `0` — plain sleep between deactivate and delete, not a health check |

## Reversibility

- **Phase A (mint) is fully reversible** — if this run fails or you decide
  not to proceed, the new key can simply be deleted (Ferry's own rollback
  does this automatically if a later step in the same run fails).
- **Phase B, deactivate step, is reversible** — `UpdateAccessKey` can flip
  the old key back to `Active` at any time (this is exactly what
  `aws/iam/user/deactivate-access-key`'s own rollback does, and this
  integration reuses the same reasoning).
- **Phase B, delete step, is NOT reversible.** Once the old key is deleted,
  it is gone forever. If rollback runs after delete has already happened, it
  can only warn loudly — it cannot un-delete.

## Gotchas

**`CONFIRM_CUTOVER=false` is not a failure — it's the expected steady state
between the two runs.** The plan will show `cutover-old-key` as a no-op with
a log line explaining it's waiting on the gate.

**A user with zero access keys is a conflict, not "nothing to do."**
Rotation presumes an existing key to rotate away from — use
`aws/iam/user/create-access-key`-style tooling (or the shared
`iamAccessKeyStep` factory) if you need the first key.

**Re-running Phase A after it already ran is safe.** With two keys already
present, `mint-new-key` does not mint a third (AWS hard-caps at two anyway)
— it just re-derives which key is old/new (preferring an already-`Inactive`
key as "old", falling back to creation-date ordering) so `cutover-old-key`
still has what it needs.

**`ROTATION_SOAK_MINUTES` is a plain sleep, not a health check.** No
real "confirm nothing broke" callback exists to wire in, so this
deliberately does not pretend to be a smart poll — it just holds the process
open for that many minutes between deactivate and delete.
