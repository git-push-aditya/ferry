# github/set-actions-secret

Encrypts a value with libsodium sealed-box and writes it as a GitHub Actions
secret at **repo**, **org**, or **environment** scope.

```bash
bun run ferry github/set-actions-secret -- --dry-run
bun run ferry github/set-actions-secret
```

## Why one integration and not three

GitHub's Actions-secrets API is the same API at all three scopes: the same
`GET .../secrets/public-key`, the same sealed-box encryption, the same
write-blind `GET .../secrets/{name}`. Only the path prefix differs, and
`SecretScope` in `src/providers/github/secrets.ts` already modelled exactly
that union.

Three folders meant three copies of the libsodium handling — the one genuinely
fiddly part of this, and so the one part worth owning exactly once. `SCOPE`
selects the path; everything else is shared.

Replaces `create-or-update-repo-secret`, `create-or-update-org-secret` and
`add-environment-secret`.

## Steps

| Step | Behavior |
| --- | --- |
| `actions-secret` | create-or-skip by default; `FORCE_ROTATE=true` routes every run through `create()`. At `SCOPE=org` only, `reconcile()` converges the readable `visibility` / selected-repository list. |
| `verify` | confirms the secret is present. At `SCOPE=org`, also re-reads and confirms `visibility`. |

## Gotchas

**The API is write-blind.** `GET .../actions/secrets/{name}` returns metadata
only — `created_at`, `updated_at` — and never the value. So `check()` can only
ever answer "a secret by this name is present", never "holds the value you
passed". That is why the default is create-or-skip rather than
always-reconcile: rewriting on every run would churn `updated_at` with no
observable change.

**`FORCE_ROTATE=true` is how you guarantee a fresh value.** It makes `check()`
always report `missing`. Safe to repeat: `PUT` is idempotent by verb, even
though sealed-box ciphertext differs byte-for-byte on every call — only the
decrypted plaintext matters.

**Rollback cannot restore a prior value, ever.** If this run *created* the
secret (HTTP 201), rollback deletes it cleanly. If this run *overwrote* an
existing one (HTTP 204), rollback leaves the current value in place and warns
loudly — the prior value was never readable, and deleting would leave the
target with no secret at all, which is worse than a possibly-wrong one.

**Org visibility changes require resupplying the value.** GitHub has no way to
change a secret's `visibility` enum without an `encrypted_value` in the same
`PUT`. A visibility-only change therefore re-encrypts `SECRET_VALUE`. A
selected-repository-list-only change uses the dedicated repositories endpoint
and touches nothing about the value.

**The container must already exist.** A missing repo (repo/environment scope)
or a missing environment is a `conflict` at plan time, not something this
integration creates. Run `github/create-environment` first where relevant.

## Verification boundary

Presence is proven. The *value* is not, and cannot be — confirming it would
require a live workflow run that reads the secret, which is out of scope here.
At org scope, `visibility` is genuinely readable and is verified.
