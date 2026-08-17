# `aws/ec2/update-instance-type`

Changes an existing EC2 instance's type via the required `stop -> modify ->
start` sequence, confirmed with a read-back. Does not launch the instance;
run `aws/ec2/launch-instance` first if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/ec2/update-instance-type --dry-run
bun run bin/ferry.ts aws/ec2/update-instance-type
```

## What it does

| Step | Notes |
| --- | --- |
| `update-instance-type` | stops the instance if not already stopped, calls `ModifyInstanceAttribute`, restarts it — using the same shared `stopInstance`/`startInstance` helpers `aws/ec2/stop-start-instance` uses |
| `verify` | re-reads the instance and confirms both the new `InstanceType` and the expected power state |

`ModifyInstanceAttribute`'s own docs are explicit that the instance "must be
in the `stopped` state" to change `instanceType` — this is a hard AWS
precondition, not a Ferry design choice.

## Design note: conditional restart

The plan's literal wording calls for the shared start helper unconditionally
as its final step. This implementation deliberately refines that: **the
instance is only restarted if it was originally running.** If it was already
stopped before this run touched it, it is left stopped after the modify.
Restarting an instance that was deliberately left stopped would be a
surprising, unrequested side effect — this integration should never do
something it wasn't asked to do. The instance's original power state is
captured in outputs before any mutation and is what both rollback and
`verify()` key off of.

## Rollback risk — read this before running against production

Rollback here is **not always fully possible**, and this integration does not
pretend otherwise:

1. **If rollback fires before the type was actually changed** (e.g. the stop
   succeeded but the process died before `ModifyInstanceAttribute` ran):
   rollback just restores the pre-run power state — starts the instance back
   up if it was originally running, or leaves it stopped if it was
   originally stopped already.

2. **If rollback fires after the type was successfully changed**: the
   instance is stopped at that point (satisfying `ModifyInstanceAttribute`'s
   precondition), so rollback reverts the type back to the original first,
   then — only if the instance was originally running — attempts to restart
   it, wrapped in a bounded `retryWithBackoff` (3 attempts) whose
   `retryable()` treats AWS capacity/availability errors (e.g.
   `InsufficientInstanceCapacity`) as retryable and rethrows anything else
   immediately.

3. **The genuine, unresolvable risk**: if the original instance type is no
   longer available in that Availability Zone (capacity exhausted, or the AZ
   stopped offering that type — both real EC2 possibilities), the bounded
   retry can be exhausted. When that happens, this integration does **not**
   report a clean rollback. It logs a loud, explicit failure — "instance type
   was reverted to `<original>`, but the instance could not be restarted;
   manual intervention required" — and rethrows so the overall run still
   reports failure. The instance is left `stopped`, with its original type
   restored but not running, and needs a manual restart (or a manual
   decision to pick a different type) afterward.

This mirrors the same honesty `aws/s3/delete-empty-bucket` already applies
to its own best-effort rollback: a failure mode this real does not get
asserted away.
