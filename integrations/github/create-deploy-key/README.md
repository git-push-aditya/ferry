# `github/create-deploy-key`

Registers an SSH deploy key on a repo, granting a single deployment target
read (or read-write) access without a personal account's own credentials.

```bash
bun run bin/ferry.ts github/create-deploy-key --dry-run
bun run bin/ferry.ts github/create-deploy-key
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`, `TITLE`,
`PUBLIC_KEY`, `READ_ONLY` (defaults `true`).

## Gotchas

**Deploy key titles are NOT enforced unique — identity is the key content
itself.** Two keys can share a title, so `check()` lists this repo's keys
and matches on the exact public-key string, not the title.

**GitHub deduplicates public keys across the WHOLE platform, separately
from the title-uniqueness fact above.** A raw `POST` of a key already
registered on some *other* repo entirely returns `422`. This is only
discoverable at `create()` time (a real, documented GitHub-side constraint)
— this task's own `check()` can only see keys already on *this* repo, so a
platform-wide collision surfaces as a `create()` failure, not a
plan-phase `conflict`.

> **Confidence note**: the platform-wide duplicate-key 422 is asserted here
> from general GitHub API knowledge of deploy-key behavior, not from a docs
> quote captured during this integration's own drafting pass — lower
> confidence than this provider's other documented behaviors, flagged per
> this project's "flag lower-confidence spots" convention.

**Private key generation is out of scope.** This integration only ever
handles the public half, the same division of responsibility Snowflake's
`rotate-user-key-pair` uses.

**`READ_ONLY` defaults to `true`.** `false` grants write access to the
repo — a meaningfully higher-privilege setting, surfaced explicitly rather
than silently defaulted, same instinct as EC2's `NoReboot` param.
