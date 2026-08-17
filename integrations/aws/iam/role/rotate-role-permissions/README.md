# `aws/iam/role/rotate-role-permissions`

Converges an existing IAM role's attached managed policies to exactly the set
you specify. Repeatable and self-idempotent: re-running with the same desired
set makes zero API calls.

```bash
bun run bin/ferry.ts aws/iam/role/rotate-role-permissions --dry-run
bun run bin/ferry.ts aws/iam/role/rotate-role-permissions
```

## What it does

| Step | Notes |
| --- | --- |
| `iam-role-exists` | abort in the plan phase if `ROLE_NAME` doesn't exist |
| `rotate-role-permissions` | diffs the live attached-policy set against `DESIRED_POLICY_ARNS` and converges it |
| `verify` | polls the role's attached-policy list until it exactly matches the desired set |

## `DESIRED_POLICY_ARNS` is a full replace, not a diff you compute yourself

Whatever ARNs you list here become the **entire** attached-managed-policy set
for the role. Anything currently attached that you don't list gets detached.
This is deliberate: safely computing the diff — and doing it in a fail-safe
order — is exactly what this integration is for. Do not pre-compute "just the
new ones" yourself; list the complete target set every time.

## Attach-before-detach is a hard invariant

When the reconcile step runs, it always attaches every new policy in
`toAttach` **before** detaching anything in `toDetach`. This means a role
can only ever become *more* permissive mid-run, never less — if the run fails
partway through, the role is left with at least as much access as it started
with, never under-permissioned. The order across the two phases is never
reordered or interleaved.

Only the *executed* attach/detach lists (what actually succeeded, which may
be a strict subset of what was planned if a partial failure occurred) are
recorded and used by rollback — not the originally-computed diff.

## Gotchas

**This only touches managed-policy attachments.** Inline policies and the
trust policy are separate concepts with their own integrations
(`create-inline-policy-for-role`, `update-trust-policy`) and are never
touched here.

**Rollback restores the starting attachment set exactly**, using the recorded
executed lists — re-attaching what was detached, then detaching what was
newly attached. `NoSuchEntityException` (role or policy already gone by
rollback time) is swallowed, not thrown.
