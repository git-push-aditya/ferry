# `aws/ec2/attach-detach-ebs-volume`

Attaches or detaches an existing EBS volume to/from an existing EC2
instance, confirmed with a polled attachment-state read-back. Does not
create the volume or the instance; run `aws/ec2/launch-instance` first if
the instance doesn't exist yet, and bring your own existing volume id
(volume creation is out of scope for this plan).

```bash
bun run bin/ferry.ts aws/ec2/attach-detach-ebs-volume --dry-run
bun run bin/ferry.ts aws/ec2/attach-detach-ebs-volume
```

## What it does

| Step | Notes |
| --- | --- |
| `attach-detach-ebs-volume` | attaches or detaches the volume per `ACTION` |
| `verify` | reads the volume's attachments back and confirms the requested destination |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `VOLUME_ID` | the EBS volume to attach/detach |
| `INSTANCE_ID` | the EC2 instance |
| `DEVICE` | e.g. `/dev/sdf` |
| `ACTION` | `attach` or `detach` |
| `FORCE` | `"true"`/`"false"`, default `false` — see Gotchas |

## Design note: one integration, two directions

Same shape as `stop-start-instance`: a single two-way toggle
(`ACTION: "attach" | "detach"`), not two separate integrations, since attach
and detach are exact mirror images of the same operation.

## Gotchas

**Same Availability Zone is a hard AWS constraint.** `AttachVolume` requires
the volume and instance to be in the same AZ. This is checked explicitly
before calling `AttachVolume`, so a mismatch surfaces as a clear error
rather than a raw AWS 4xx.

**Attaching to a different instance is a conflict, not an auto-move.** If
the volume is already attached to a *different* instance than named in
params, `check()` returns `"conflict"` — this integration never silently
detaches and reattaches elsewhere; that's a distinct, more destructive
operation you'd need to ask for explicitly (two separate runs).

**The root volume can't be detached from a running instance.** AWS: "If an
EBS volume is the root device of an instance, it can't be detached while
the instance is running. To detach the root volume, stop the instance
first." This integration surfaces that as a `"conflict"` at `check()` time
— it does not stop the instance for you. Use `aws/ec2/stop-start-instance`
first if you need to detach a root volume.

**`FORCE=true` is a last resort, not a default.** Straight from AWS's own
`DetachVolume` docs: forcing a detach "can lead to data loss or a corrupted
file system" and "should be used only as a last resort to detach a volume
from a failed instance." Defaults to `false`; only set it when a normal
detach is stuck.

**Rollback is a genuine undo.** If this run attached, rollback detaches at
the same device; if this run detached, rollback re-attaches at the same
device it was detached from (captured in outputs at create time). Neither
direction touches volume contents.
