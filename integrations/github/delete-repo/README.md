# `github/delete-repo`

Deletes a GitHub repo. Never creates one — this integration never runs
`github/create-repo`'s job for you; that's a real precondition, not a cycle.

```bash
bun run bin/ferry.ts github/delete-repo --dry-run
bun run bin/ferry.ts github/delete-repo
```

## What it does

| Step | Notes |
| --- | --- |
| `confirm-destructive-teardown` | aborts the plan phase (`conflict`) unless `ALLOW_DESTRUCTIVE_TEARDOWN=true` |
| `delete-repo` | inverted create-or-skip — `DELETE /repos/{owner}/{repo}`; a repo already gone is a clean no-op |
| `verify` | confirms `GET /repos/{owner}/{repo}` now 404s |

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`,
`ALLOW_DESTRUCTIVE_TEARDOWN` (defaults `false`).

## Gotchas

**This is real, total, irreversible data loss.** Commit history, issues,
PRs, and settings are all gone for good — this tool has no undo path.
GitHub support can sometimes restore a deleted repo within a short window,
but that's a human support-ticket process, not an API call this integration
can invoke, so `rollback()` only ever warns loudly rather than pretending to
undo anything.

**Synchronous delete, no async lifecycle to poll.** Unlike EC2 termination,
GitHub's repo delete is immediate per its own docs — `verify()` does a
single read-back rather than polling for eventual consistency.

**Re-running against an already-deleted repo is a clean skip**, not an
error — `check()` inverts the usual create-or-skip meaning: "missing" means
"still present, needs deleting" and "exists" means "already gone, target
state achieved."
