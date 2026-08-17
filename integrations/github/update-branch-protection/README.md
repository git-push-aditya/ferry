# `github/update-branch-protection`

Reconciles a branch's protection ruleset to an exact desired document. Never
creates the branch itself — a real precondition, not a cycle.

```bash
bun run bin/ferry.ts github/update-branch-protection --dry-run
bun run bin/ferry.ts github/update-branch-protection
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example` for the full field set:
required status checks, required PR reviews, `enforce_admins`, and push
restrictions — each toggleable independently via its own `ENABLE_*` flag.

## Gotchas

**Whole-document PUT, not a partial PATCH.** Every apply supplies the full
desired document; there is no "add one requirement" API. Re-applying the
same document is a true no-op in effect.

**`enforce_admins` has an asymmetric read/write shape.** `PUT` takes a bare
boolean; `GET` wraps it as `{ enabled: boolean }`. This integration
normalizes that difference internally — see
`src/providers/github/branch-protection.ts`'s `branchProtectionMatches`.

**A missing branch is a `conflict`, not an auto-create.** This task never
creates branches — same non-auto-create discipline as
`aws/ec2/update-security-group-rules` refusing to create its target group.

**Rollback is a real, complete restore either way** — the pre-reconcile
document (if any) is captured before the PUT, so rollback either PUTs it
back verbatim or DELETEs protection entirely if there was none before this
run. Unlike most of this provider's other rollbacks, this one is not
lossy.
