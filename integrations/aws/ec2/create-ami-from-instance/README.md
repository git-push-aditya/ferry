# `aws/ec2/create-ami-from-instance`

Creates an AMI from an existing EC2 instance.

```bash
bun run bin/ferry.ts aws/ec2/create-ami-from-instance --dry-run
bun run bin/ferry.ts aws/ec2/create-ami-from-instance
```

## NO_REBOOT — a real side effect, on by default

**By default (`NO_REBOOT=false`, matching `CreateImage`'s own API default),
creating this AMI reboots the source instance.** This is a documented,
deliberate AWS behavior, not a bug: per AWS's own docs, the reboot happens
"to ensure that all buffered data and data in memory is written to the
volumes before the snapshots are created" — i.e. full consistency.

Setting `NO_REBOOT=true` skips the reboot, but the tradeoff is real and
quoted directly from AWS's own wording: the resulting snapshots then only
capture "data that has been written to the volumes at the time the
snapshots are created" — crash-consistent, not fully consistent. Neither
value is silently assumed; `NO_REBOOT` is a fully configurable param and
both branches are logged explicitly during `create()`.

If you're baking an AMI from a live, in-service instance, expect the reboot
unless you've deliberately opted out of it and accepted the consistency
tradeoff.

## What it does

`check()` looks up any AMI owned by this account tagged with this
integration's id and the caller-supplied `LOGICAL_NAME` (same approach as
`create-ebs-snapshot` — there's no natural "does this AMI already exist"
check by name or content). A match in `pending` or `available` state is
`"exists"`; no match is `"missing"`.

`create()` calls `CreateImage` with the identity tags applied to the image,
then polls `DescribeImages` until `State == "available"` — a `"failed"`
state (or a populated `StateReason`) during the poll fails immediately
rather than continuing to wait. The resulting `imageId` and every backing
snapshot id (from `BlockDeviceMappings`) are captured into outputs, since
rollback needs them.

`rollback()` deregisters the AMI, then deletes every backing snapshot
captured above — both are this run's own creations, so a full (not
best-effort) cleanup is correct: deregistering an AMI does **not**
automatically delete its snapshots.

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `INSTANCE_ID` | source instance, must already exist |
| `LOGICAL_NAME` | identity tag for idempotent lookup — not the AMI's `Name` |
| `AMI_NAME` | the AMI's `Name` field |
| `DESCRIPTION` | optional |
| `NO_REBOOT` | `"true"`/`"false"`, default `false` — see the section above |
| `TAGS_JSON` | optional flat JSON object, applied alongside the identity tags |

## Gotchas

**Idempotency depends entirely on the identity tag, not the AMI name.**
`CreateImage` is not idempotent by AWS itself (no client-token support), so
a re-run after an interruption relies on `check()` finding the previously
tagged image (still `pending` or now `available`) rather than baking a
second AMI.

**Rollback is a full cleanup, not best-effort.** Both the AMI and its
backing snapshots were created by this run, so both get cleaned up
completely if a later step's failure triggers an unwind.
