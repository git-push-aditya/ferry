# `aws/ec2/create-security-group`

Creates a security group with a starting ingress/egress rule set, keyed on
name+VPC per AWS's own per-VPC name-uniqueness rule (the same "existence
without proven ownership must never be silently adopted" discipline as
S3's bucket-ownership check, scoped to a VPC instead of globally).

```bash
bun run bin/ferry.ts aws/ec2/create-security-group --dry-run
bun run bin/ferry.ts aws/ec2/create-security-group
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `create-security-group` | security group + starting ingress/egress rules | See "Two-layer design" below |
| `verify` | live rule set matches the expected starting set | Both directions |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `GROUP_NAME` | unique within `VPC_ID` |
| `GROUP_DESCRIPTION` | required by `CreateSecurityGroup` |
| `VPC_ID` | must already exist — external precondition, not created here |
| `INGRESS_RULES` | JSON array of `{ protocol, fromPort?, toPort?, cidr?, sourceGroupId? }` |
| `EGRESS_RULES` | same shape, defaults to `[]` |

## Two-layer design: `create()` + `reconcile()`

This is a deliberate deviation from a pure create-or-skip step. The group's
*existence* (name/VPC don't change once created) is create-or-skip, but a
group that exists with an *incomplete* starting rule set — from an
interrupted first run — would otherwise never get its missing rules
retried, because `check()` finding the tagged group would report `"exists"`
and `create()` (the only place the starting rules were applied) would never
run again.

The fix: this step also has `reconcile()`, which the engine runs whenever
`create()` did not. It re-diffs the same starting rule list against
whatever's actually live on the group and applies only what's still
missing — closing that gap without ever reverting to a pure "always
reconcile" step (a security group's starting rules are a one-time bootstrap
concern; *ongoing* rule changes are `aws/ec2/update-security-group-rules`'s
job, kept as a separate integration deliberately since create-or-skip and
always-reconcile are different re-run semantics).

## Shared rule-diff logic

Both this integration's `reconcile()` and `aws/ec2/update-security-group-
rules`'s reconcile step touch a security group's rule set, so the
diff/apply logic (`diffRules`, `applyRuleDiff`, `pollRulesConverged`) lives
in exactly one place —
`integrations/aws/ec2/update-security-group-rules/steps/rules.ts` — and
this integration imports it by relative path. This is the plan's own
explicit recommendation: one shared implementation, not two independently
drifting copies.

## Rollback

`rollback()` deletes the group by its captured id. If the group is still
referenced by a running instance, `DeleteSecurityGroup` fails with
`DependencyViolation` — caught and logged as a warning rather than thrown,
since the engine's rollback runner must never itself throw mid-unwind.
