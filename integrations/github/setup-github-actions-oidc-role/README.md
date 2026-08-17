# `github/setup-github-actions-oidc-role`

Wires an AWS IAM role to trust GitHub Actions' OIDC tokens, so a workflow
can assume AWS credentials with **no long-lived AWS secret stored in
GitHub at all** — the standard, AWS-and-GitHub-both-recommended replacement
for static access keys in CI. A natural alternative to this project's own
`aws/iam/user/create-access-key`/`rotate-access-key` for CI use cases
specifically.

```bash
bun run bin/ferry.ts github/setup-github-actions-oidc-role --dry-run
bun run bin/ferry.ts github/setup-github-actions-oidc-role
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `oidc-provider-and-role` | IAM OIDC identity provider (account-shared) + bare IAM role | create-or-skip on both pieces jointly |
| `trust-policy-and-attach` | the role's trust policy + attached permission policies | always-reconcile |
| `verify` | re-reads the provider's client-id list and the role's trust policy | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` **only**. This integration never
calls a GitHub API — `GITHUB_OWNER`/`GITHUB_REPO`/`SCOPE_VALUE` are plain
strings baked into the trust policy's `sub` claim, which AWS never
validates against a live GitHub API. No `GITHUB_TOKEN` needed.

**This folder's `.env`** — see `.env.example`: `GITHUB_OWNER`,
`GITHUB_REPO`, `SCOPE_TYPE` (`branch`/`environment`), `SCOPE_VALUE`,
`ALLOW_ANY_REF_OR_ENVIRONMENT`, `AWS_ROLE_NAME`, `ROLE_DESCRIPTION`,
`PERMISSION_POLICY_ARNS`.

## Gotchas

**No GitHub-side verification of the repo/branch/environment name is
possible or attempted.** A misconfigured `sub` claim (wrong repo name, say)
only surfaces later when a real workflow run attempts
`AssumeRoleWithWebIdentity` and AWS rejects the mismatched claim — an
inherent boundary of this integration's `verify()`, same class as
`resize-ebs-volume`'s filesystem-extension boundary. Chain
`github/trigger-workflow-dispatch` (with `WAIT_FOR_COMPLETION=true`)
against a dedicated smoke-test workflow afterward for a real end-to-end
confirmation — not built into this task automatically, since forcing a live
workflow run on every apply would be a surprising, costly side effect.

**`ALLOW_ANY_REF_OR_ENVIRONMENT` is a deliberate, opt-in security loosening,
default `false`.** It switches the trust condition from a tight
`StringEquals` match on one exact branch/environment to a `StringLike`
wildcard (`repo:OWNER/REPO:*`) — materially widening which workflow runs
can assume this role. Confirm this choice with reviewers before flipping it.

**The OIDC identity provider is account-wide and shared.** It is created
only if missing, and — critically — **rollback never deletes it unless
this run created it fresh.** Other, unrelated roles in the same account may
already depend on it; deleting it as a side effect of rolling back one
role's setup would be a much wider blast radius than this task's scope.

**No thumbprint is supplied when creating the OIDC provider.**

> **Confidence note**: modern AWS accounts no longer require a manually
> supplied thumbprint for GitHub's provider (AWS validates GitHub's
> certificate chain automatically as of a documented platform update) —
> this is the single lowest-confidence fact in this integration.
> Re-verify against the AWS account's actual API/SDK behavior before
> relying on this in a brand-new account; some SDK versions may still
> expect a `ThumbprintList` even where AWS no longer uses it for
> validation.

**Trust-policy reconcile logic is reimplemented locally, not imported from
`aws/iam/role/update-trust-policy`.** That integration's own step is typed
to its own params shape, not exported as a shared factory the way
`iamRoleStep`/`iamAttachRolePolicyStep` are — this task's
`steps/trust-policy-and-attach.ts` mirrors the same whole-document-replace
algorithm rather than importing across integration folders.
