# `aws/ec2/create-ebs-snapshot`

Creates a point-in-time snapshot of an existing EBS volume, confirmed by
polling until it reaches `completed`. Does not create the volume; bring
your own existing volume id.

```bash
bun run bin/ferry.ts aws/ec2/create-ebs-snapshot --dry-run
bun run bin/ferry.ts aws/ec2/create-ebs-snapshot
```

## What it does

| Step | Notes |
| --- | --- |
| `create-ebs-snapshot` | creates the snapshot, tagged with `ferry:integration-id` + `ferry:logical-name` for idempotent lookup; polls until `completed` |
| `verify` | reads the snapshot back and confirms `completed` + the right source `VolumeId` |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `VOLUME_ID` | the EBS volume to snapshot |
| `LOGICAL_NAME` | identity tag — used to find an already-created snapshot on a retried run |
| `DESCRIPTION` | optional |
| `TAGS` | optional flat JSON object, e.g. `{"env":"prod"}` |
| `STOP_INSTANCE_FIRST` | `"true"`/`"false"`, default `false` |
| `INSTANCE_ID` | required only if `STOP_INSTANCE_FIRST=true` |

## Idempotency: identity tags, not a natural key

Snapshots are point-in-time — there's no natural "does a snapshot named X
already exist" the way there is for a bucket. `CreateSnapshot` has no
client token either, so a naive retry would create a second, redundant
snapshot. Instead, `check()` looks up `DescribeSnapshots` filtered by
`tag:ferry:integration-id`, `tag:ferry:logical-name`, and `volume-id` — a
matching snapshot in `pending` or `completed` state is treated as
`"exists"`, so pick a stable, meaningful `LOGICAL_NAME` per distinct backup
you want tracked (e.g. `nightly-backup`, not something that changes every
run).

## `STOP_INSTANCE_FIRST` is a convenience, not a requirement

EBS can snapshot an attached, in-use volume directly — "You can take a
snapshot of an attached volume that is in use." Stopping the instance first
is AWS's own recommendation specifically for a fully consistent **root
device** snapshot, not a hard requirement for snapshotting in general. This
integration exposes it as an opt-in (`STOP_INSTANCE_FIRST=true` +
`INSTANCE_ID`) using the same shared `stopInstance`/`startInstance` helpers
as `stop-start-instance`, rather than forcing every snapshot to stop its
instance. The instance is restarted after the snapshot completes — or
fails — either way.

## Gotchas

**An `error` state during the poll fails fast.** If the snapshot enters
`error` while it's completing, this integration throws immediately rather
than polling to the (long, ~20 minute) timeout.

**Rollback deletes the snapshot.** Exact and lossless — deleting a
just-created snapshot loses nothing that existed before this run.
