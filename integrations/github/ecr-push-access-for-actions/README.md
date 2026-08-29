# `github/ecr-push-access-for-actions`

Lets an existing GitHub Actions OIDC role push images to one ECR
repository — the single most common "why does our CI need a static AWS
key" case in practice. Creates the ECR repository and grants a scoped
inline policy to a role that already exists; never mints the role or the
OIDC provider itself.

```bash
bun run bin/ferry.ts github/ecr-push-access-for-actions --dry-run
bun run bin/ferry.ts github/ecr-push-access-for-actions
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-role-exists` | (guard) confirms `AWS_ROLE_NAME` already exists | conflict if it doesn't — run `github/setup-github-actions-oidc-role` first |
| `ecr-repo` | ECR repository | create-or-skip; no settings-drift reconcile |
| `inline-policy` | a scoped inline policy on the OIDC role | always-reconcile, whole-document-replace |
| `verify` | re-reads the repository and the inline policy | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`: `AWS_ROLE_NAME` (the
already-provisioned OIDC role from `github/setup-github-actions-oidc-role`),
`ECR_REPOSITORY_NAME`, `IMAGE_TAG_MUTABILITY`, `ALLOW_DESTRUCTIVE_ROLLBACK`.

## Gotchas

**`ecr:GetAuthorizationToken` cannot be resource-scoped** — it is a
registry-wide action; the policy this integration writes hardcodes
`Resource: "*"` for that one statement and does not expose it as a
configurable param, to avoid a common, easy-to-make mistake (a resource
ARN there is a silent no-op).

**`imageScanningConfiguration` is deliberately not a param.** It is on a
documented deprecation path in favor of registry-level scan configuration
— this integration does not present a deprecated per-repo option as
current best practice. Re-confirm against the `@aws-sdk/client-ecr`
version in use if scan-on-push is needed; it isn't wired up here.

**No settings-drift reconcile on the repository itself.** `IMAGE_TAG_
MUTABILITY` is set once at creation, same "create-only" stance
`github/create-environment` takes toward its own settings. Changing it
later requires a manual `PutImageTagMutability` call outside this
integration.

**Rollback deletes the repository only with `ALLOW_DESTRUCTIVE_ROLLBACK=
true`.** A repository can hold real images pushed by CI runs between
creation and rollback — deleting it is real data loss, not a clean undo,
same gate class as `github/create-repo`'s destructive rollback.
