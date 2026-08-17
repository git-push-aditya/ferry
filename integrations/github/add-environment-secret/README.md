# `github/add-environment-secret`

Same write-blind shape as `create-or-update-repo-secret`, scoped to a named
deployment environment instead of the whole repo. See that integration's
README for the full write-blind / `FORCE_ROTATE` / non-destructive-rollback
discussion — it applies here unchanged.

```bash
bun run bin/ferry.ts github/add-environment-secret --dry-run
bun run bin/ferry.ts github/add-environment-secret
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`,
`ENVIRONMENT_NAME`, `SECRET_NAME`, `SECRET_VALUE`, `FORCE_ROTATE`.

## Gotchas

**This task never creates the environment.** A missing `ENVIRONMENT_NAME`
is a plan-phase `conflict`, same non-auto-create discipline as
`update-branch-protection`'s missing-branch case. Run
`github/create-environment` first.

**Environment secrets are a distinct API surface from repo secrets** — a
different base path (`/repos/{owner}/{repo}/environments/{name}/secrets`),
otherwise identical semantics (write-blind value, public-key + sealed-box
write, presence-only `check()`). Both scopes share the same
`src/providers/github/secrets.ts` functions, parameterized rather than
duplicated.
