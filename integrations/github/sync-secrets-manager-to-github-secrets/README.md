# `github/sync-secrets-manager-to-github-secrets`

Takes a value that already lives in AWS Secrets Manager and pushes a copy
into a GitHub Actions repo or environment secret, so a workflow can consume
it via `secrets.*` context without a manual copy-paste step.

**A real, competing alternative exists**: a caller could instead grant
`github/setup-github-actions-oidc-role`'s own role read access to Secrets
Manager directly (`secretsmanager:GetSecretValue`), letting the workflow
read the value live instead of duplicating it into GitHub. This task exists
specifically for callers who want a GitHub-native secret instead — e.g. for
use with actions that only read `secrets.*` context.

```bash
bun run bin/ferry.ts github/sync-secrets-manager-to-github-secrets --dry-run
bun run bin/ferry.ts github/sync-secrets-manager-to-github-secrets
```

## What it needs

**Root `.env`** — `credentials: ["aws", "github"]` (both — this is the one
task in this provider that genuinely talks to both APIs).

**This folder's `.env`** — see `.env.example`: `SOURCE_SECRET_ID`, `OWNER`,
`REPO`, `TARGET_SCOPE` (`repo`/`environment`), `ENVIRONMENT_NAME` (required
when `TARGET_SCOPE=environment`), `TARGET_SECRET_NAME`.

## Gotchas

**Write-blind on both ends, but for different reasons.** Secrets Manager's
`GetSecretValue` genuinely CAN read the source value — but `check()`
deliberately does not call it on every plan, since that would mean every
`ferry plan` silently reads a live secret into process memory even when
nothing needs to change (a real credential-hygiene concern). Instead,
`check()` compares Secrets Manager's own current-version marker (the
version labeled `AWSCURRENT`) against a `ferry:last-synced-version` **tag**
this task writes on the source secret — a tag, not `ctx.outputs`, since
outputs aren't guaranteed to persist across separate CLI invocations the
way a resource tag does (same reasoning `create-ebs-snapshot`/
`create-ami-from-instance` use tags for their own cross-run identity).

**The plaintext value is read only once `check()` has already established
the source changed**, held in a local variable for the duration of one
step, and never assigned to `ctx.outputs`, `resource()`, or logged.

**Rollback does not touch the source secret's value** — it was only ever
read, never modified. Rollback removes the version-sync tag only, so the
next run re-detects "needs sync" instead of believing a rolled-back GitHub
secret is still current. The GitHub-side value itself inherits the same
write-blind, non-restorable limitation as `create-or-update-repo-secret`.

**This is the one task in this provider requiring both `aws` and `github`
credentials at once.** Contrast with `setup-github-actions-oidc-role`,
which only ever calls AWS APIs despite also being "AWS+GitHub" in name.

**A second AWS-only or AWS+GitHub task needing the same Secrets-Manager
read/tag pattern would be the trigger to promote
`steps/secrets-manager-read.ts` into `src/providers/aws/secretsmanager.ts`**
— it stays local here per this project's "two bespoke copies are fine, a
third gets promoted" convention, since this is currently its only consumer.
