# `github/enable-disable-workflow`

Toggles a GitHub Actions workflow's enabled state.

```bash
bun run bin/ferry.ts github/enable-disable-workflow --dry-run
bun run bin/ferry.ts github/enable-disable-workflow
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`,
`WORKFLOW_ID` (numeric id or filename), `ACTION` (`enable`/`disable`).

## Gotchas

**Never creates the workflow file.** A missing/bad `WORKFLOW_ID` is a plan-
phase `conflict`, not an auto-create — committing a workflow YAML is a git
operation, out of scope here, same "doesn't reach across into a different
concern" discipline as `attach-detach-ebs-volume` declining to auto-stop an
instance.

**Fully reversible.** Rollback reverses the toggle — same shape as
`stop-start-instance`/`iamAccessKeyStatusStep`.
