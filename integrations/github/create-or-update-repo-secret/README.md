# `github/create-or-update-repo-secret`

Encrypts and writes a repo-scoped Actions secret via libsodium sealed-box —
the only documented way to write a GitHub Actions secret; there is no
plaintext-write path.

```bash
bun run bin/ferry.ts github/create-or-update-repo-secret --dry-run
bun run bin/ferry.ts github/create-or-update-repo-secret
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`,
`SECRET_NAME`, `SECRET_VALUE` (never logged), `FORCE_ROTATE` (defaults
`false`).

## Gotchas

**Write-blind, permanently.** `GET .../actions/secrets/{name}` returns only
`created_at`/`updated_at` — GitHub never returns a secret's value once
written, by design. `check()` can therefore only ever know "does a secret by
this name exist," never "does it hold the value params want." A secret
changed by hand, or by another tool, after this integration first wrote it
will **never** be detected or corrected unless you set `FORCE_ROTATE=true`.

**Default mode is create-or-skip, not always-reconcile.** Unlike
`update-branch-protection`'s whole-document PUT, re-encrypting and
re-writing this secret on every single run regardless of `check()` would be
wasteful and would churn `updated_at` with zero behavior change. Set
`FORCE_ROTATE=true` if you specifically want every run to guarantee a fresh
ciphertext write (safe: `PUT` is idempotent-by-verb even though the
ciphertext itself differs byte-for-byte every call — sealed-box encryption
is randomized, but only the decrypted plaintext GitHub Actions sees ever
matters).

**Rollback cannot restore an overwritten value.** If this run created a
brand-new secret (API returned 201), rollback deletes it cleanly. If this
run overwrote a pre-existing secret (API returned 204), rollback leaves the
new value in place with a loud warning — deleting it would leave the repo
with **no** secret at all, a worse outcome than "possibly wrong value."

**Verification is shallow.** `verify()` can only confirm the secret exists;
confirming the value actually took effect would require dispatching a real
workflow run that reads it, out of scope for this task.
