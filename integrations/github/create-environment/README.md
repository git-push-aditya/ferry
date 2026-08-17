# `github/create-environment`

Creates a deployment environment with reviewers, a wait timer, and an
optional deployment-branch policy.

```bash
bun run bin/ferry.ts github/create-environment --dry-run
bun run bin/ferry.ts github/create-environment
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`,
`ENVIRONMENT_NAME`, `WAIT_TIMER`, `REVIEWERS`,
`ENABLE_DEPLOYMENT_BRANCH_POLICY`, `PROTECTED_BRANCHES`,
`CUSTOM_BRANCH_POLICIES`.

## Gotchas

**Create-or-skip, not always-reconcile.** An environment's identity (its
name) doesn't change once created, and this task does not reconcile
settings drift on an already-existing environment — same "check is
shallow, not drift detection" rule used throughout this project, mirroring
`create-security-group`'s own group-existence-only check.

**Deleting an environment cascades to its secrets.** `add-environment-secret`
scopes secrets to a named environment; deleting the environment (via
rollback, or by hand) removes all of them too — a wider blast radius than
deleting a single repo secret.

**`PUT` is itself idempotent-by-verb** (a `PUT` to a non-existent
environment name creates it) — this doubles up with, rather than replaces,
this task's own presence check.
