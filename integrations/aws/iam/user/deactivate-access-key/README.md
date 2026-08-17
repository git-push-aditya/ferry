# `aws/iam/user/deactivate-access-key`

Deactivates one named access key on an existing IAM user (`Status -> Inactive`).

```bash
bun run ferry aws/iam/user/deactivate-access-key -- --dry-run
bun run ferry aws/iam/user/deactivate-access-key
```

## What it does

| Step | Resource | Notes |
| --- | --- | --- |
| `access-key-status` | the named access key's `Status` | reconciles to `Inactive`; skipped if already `Inactive` or already gone |
| `verify` | — | confirms via `ListAccessKeys` (short propagation-tolerant poll) |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `IAM_USER_NAME` | plain AWS name |
| `ACCESS_KEY_ID` | which of the user's (up to two) keys to target — required, never inferred |

## Reversibility

**This is fully reversible**, unlike delete. `UpdateAccessKey` can flip the
key back to `Active` at any time — this is precisely why AWS's own rotation
guidance recommends deactivate-then-soak *before* ever deleting a key (see
`aws/iam/user/rotate-access-key`, whose cutover phase reuses this same
underlying step).

## Gotchas

**No negative-control check.** `verify()` only confirms the key's `Status`
via `ListAccessKeys` — it does not attempt a live call using the key's own
credentials to prove it's now denied, because this integration is never
handed the key's secret (only its id). If you need that stronger proof, you
already hold the secret from wherever the key was originally minted.

**`ACCESS_KEY_ID` is required, never inferred.** A user can hold up to two
access keys at once; guessing which one to deactivate would be unsafe.
