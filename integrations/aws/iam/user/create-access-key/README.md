# `aws/iam/user/create-access-key`

Mints an access key for an existing IAM user, respecting AWS's hard 2-key-per-user
cap, proven with a live `sts:GetCallerIdentity` call made **as the new key**.

```bash
bun run ferry aws/iam/user/create-access-key -- --dry-run
bun run ferry aws/iam/user/create-access-key
```

Operates on a user this integration does **not** create — run
`aws/iam/user/create-user` first if it doesn't exist yet.

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-user-exists` | precondition only | aborts in the plan phase if the user is missing, rather than failing partway through apply |
| `access-key` | access key pair | created only if the user holds fewer than 2 keys and either holds 0, or holds 1 and `ALLOW_SECOND_KEY=true` |
| `verify` | `sts:GetCallerIdentity` **as the new key** | confirms the returned ARN identifies `IAM_USER_NAME` |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `IAM_USER_NAME` | plain AWS name, must already exist |
| `ALLOW_SECOND_KEY` | `true`/`false`, defaults to `false` |

## The 2-key hard cap

`CreateAccessKey` beyond 2 keys per user returns `LimitExceeded` — this is not
configurable and not raisable via a quota increase request. This integration's
`check()` encodes the cap directly:

- **0 keys** → always minted.
- **1 key** → left alone unless `ALLOW_SECOND_KEY=true` (the ambiguous case:
  is this a "give me the key I don't have" run, or a rotation-window run?
  `ALLOW_SECOND_KEY` disambiguates it explicitly rather than guessing).
- **2 keys** → always left alone. A third `create()` would 409 regardless of
  `ALLOW_SECOND_KEY`.

To rotate: set `ALLOW_SECOND_KEY=true`, run this integration to mint the second
key, cut services over to it, then delete the old key in IAM.

## Gotchas

**The full secret is printed once, to stdout, and not written to any file.**
The report under `output/` carries the masked value only, exactly like
`aws/s3/create-backend-s3-user`. If you lose the full secret, delete the key in
IAM and re-run with `ALLOW_SECOND_KEY=true`.

**Verification degrades honestly when no key was minted.** If the user already
held a key and `ALLOW_SECOND_KEY=false`, there is no new identity to exercise —
`verify()` skips the live check and logs a warning explaining why, instead of
silently passing.

**New credentials need a moment.** A freshly minted key reads as denied by STS
for a few seconds after `CreateAccessKey` returns success, so the first
`sts:GetCallerIdentity` call retries with backoff on `InvalidAccessKeyId` /
`SignatureDoesNotMatch` only — a genuine credential problem still fails fast.
