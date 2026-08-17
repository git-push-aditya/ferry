# `aws/ec2/update-security-group-rules`

Reconciles a security group's ingress/egress rule set to exactly what's
declared in params. Repeatable and non-creating: every run reads the live
rule set, diffs it against the desired set, and applies only the delta
(revoke the extras, authorize the missing) — converging to a no-op as it
catches up, the same "always-reconcile, self-idempotent" idiom as
`aws/s3/create-bucket`'s versioning/encryption steps.

```bash
bun run bin/ferry.ts aws/ec2/update-security-group-rules --dry-run
bun run bin/ferry.ts aws/ec2/update-security-group-rules
```

## What it reconciles

| Step | Resource | Notes |
| --- | --- | --- |
| `reconcile-security-group-rules` | ingress + egress rule sets on `GROUP_ID` | Always reconciled — diff-then-apply, not a single PUT (no such API exists for rule sets) |
| `verify` | live rule set set-equals the desired set | Both directions |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `GROUP_ID` | must already exist — see below |
| `DESIRED_INGRESS_RULES` | JSON array of `{ protocol, fromPort?, toPort?, cidr?, sourceGroupId? }`, the FULL desired set |
| `DESIRED_EGRESS_RULES` | same shape, defaults to `[]` |

## This integration never creates the group

Real precondition, not a cycle: `GROUP_ID` must point at a security group
that already exists. `check()` reports `"conflict"` if it doesn't, aborting
before any mutation — mirroring `aws/s3/sync-bucket-contents`'s refusal to
auto-create its source/destination buckets. Use
`aws/ec2/create-security-group` (or any existing group) to get an id first.

## The shared diff/apply logic

Both this integration and `create-security-group`'s `reconcile()` step touch
a security group's rule set, so the diff-then-apply logic lives in exactly
one place — `steps/rules.ts` in this folder — and `create-security-group`
imports it by relative path. This avoids two independent implementations of
the same add/remove diff drifting apart, per the plan's own explicit
recommendation.

## Rollback is exact and fully reversible

Unlike `terminate-instance`, security group rule changes have no data-loss
risk, so rollback is a real undo: it replays the diff in reverse using the
pre-image captured during `reconcile()` — re-authorizing whatever that run
revoked, and re-revoking whatever it added — restoring the group to its
exact prior rule set.

## `check()` always returns `"missing"` when the group exists

There is no clean "already matches" skip state distinguishable at `check()`
time without doing the same diff work `reconcile()` does anyway (`check()`
is meant to be a shallow presence probe, not a diff — see
`src/core/define.ts`). So `check()` here just confirms the group exists
(`"conflict"` if not) and always defers the actual comparison to
`reconcile()`, which short-circuits to a no-op internally when the live set
already matches desired. This mirrors the `s3VersioningStep` always-reconcile
idiom rather than trying to force a three-way `check()` split that doesn't
actually save any work.
