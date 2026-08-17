# `github/create-repo`

Creates a GitHub repo under a user or org account. The root of the dependency
graph for every other `github/*` task — `update-branch-protection`,
`add-remove-collaborator`, `create-or-update-repo-secret`, `create-webhook`,
`create-deploy-key`, `create-environment`, and friends all assume a repo
already exists, either from a prior run of this integration or from a repo
provisioned outside Ferry.

```bash
bun run bin/ferry.ts github/create-repo --dry-run
bun run bin/ferry.ts github/create-repo
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `github-repo` | GitHub repo | create-or-skip; skipped if a repo of this name already exists under this owner |
| `verify` | re-reads the repo and confirms visibility matches what was requested | — |

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `OWNER` | user or org login |
| `REPO` | bare repo name |
| `OWNER_TYPE` | `user` or `org` — selects `/user/repos` vs. `/orgs/{OWNER}/repos` |
| `DESCRIPTION` | optional |
| `VISIBILITY` | optional, `public` or `private` |
| `AUTO_INIT` | optional, defaults `true` |
| `GITIGNORE_TEMPLATE` / `LICENSE_TEMPLATE` | optional |
| `ALLOW_DESTRUCTIVE_ROLLBACK` | optional, defaults `false` — see Gotchas |

## Gotchas

**Repo names are unique per-owner, not globally.** Unlike S3 bucket names,
there is no "exists but isn't ours" third state — a successful `GET
/repos/{owner}/{repo}` always means either this owner's repo (a clean skip)
or a completely different owner's repo (which this integration would never
even reach, since the owner segment is part of the request path itself).

**`AUTO_INIT` defaults to `true`, unlike a bare AWS resource.** A fully empty
repo (no branches, no commits) would make `update-branch-protection` 404
immediately if chained after this task. Set `AUTO_INIT=false` explicitly if
you want a genuinely empty repo (e.g. as a push target for an external CI
system that will make the first commit itself).

**Rollback is a real irreversible-data-loss risk, gated behind an explicit
flag.** Unlike `create-bucket`'s empty-bucket rollback (genuinely lossless),
anything committed to this repo between creation and a rollback is destroyed
along with the repo if `ALLOW_DESTRUCTIVE_ROLLBACK=true`. Leaving it `false`
(the default) means a failed later step in a chained run leaves this repo
behind rather than deleting it — inspect and clean it up by hand.

**No async lifecycle to poll.** GitHub's repo creation is synchronous, unlike
IAM's eventually-consistent reads — `verify()` does a single read-back rather
than polling.
