# `aws/ec2/resize-ebs-volume`

Grows an EBS volume to a target size.

```bash
bun run bin/ferry.ts aws/ec2/resize-ebs-volume --dry-run
bun run bin/ferry.ts aws/ec2/resize-ebs-volume
```

## The AWS-side/in-OS boundary — read this first

**Growing the volume in AWS does not grow the filesystem inside the guest
OS.** This is not this integration cutting a corner — it's the literal,
documented behavior of `ModifyVolume` itself:

> "When you complete a resize operation on your volume, you need to extend
> the volume's file-system size to take advantage of the new storage
> capacity."

AWS links that out to a distinct "Extend the file system" guide, because the
two are genuinely different operations with a different trust boundary:
resizing the volume is an AWS API call, while extending the partition and
filesystem (`growpart`/`resize2fs`/`xfs_growfs` on Linux, Disk Management on
Windows) requires running commands *inside* the instance.

**By default, this integration only does the AWS-side resize.** It does not
pretend to grow the filesystem for you. If you leave `SSM_DOCUMENT_NAME` and
`SSM_INSTANCE_ID` unset, the run stops once the AWS-side resize is confirmed,
and both the report and `verify()` say plainly that filesystem growth was
not performed or checked.

## Optional SSM sub-step (opt-in, not default)

If — and only if — you set **both** `SSM_DOCUMENT_NAME` and
`SSM_INSTANCE_ID`, `create()` runs an SSM Run Command document against that
instance after the AWS-side resize is confirmed, and polls the command's own
status until `Success` (or fails immediately on `Failed`/`Cancelled`/
`TimedOut`). This is entirely your responsibility to configure correctly —
the SSM document must actually perform the in-OS grow (e.g. AWS's own
`AWS-RunShellScript` running `growpart`/`resize2fs`, or a custom document).
This integration does not ship or validate the document's contents.

## What it does

`check()` compares the volume's current `Size` to `TARGET_SIZE_GIB`:
already `>=` target is `"exists"` (nothing to do, or already resized by a
prior run). Smaller is `"missing"`. A `TARGET_SIZE_GIB` smaller than the
current size is rejected as a **params validation error**, not surfaced as a
runtime conflict — EBS volumes can only grow via `ModifyVolume`; shrinking
isn't an operation the API supports at all.

`check()` also looks for an in-flight modification (`DescribeVolumesModifications`)
targeting a *different* size than requested — that's `"conflict"`, aborting
before a second concurrent `ModifyVolume` (which the API itself would
reject). An in-flight modification already targeting the *same* desired size
is treated as `"missing"` still, so `create()` can skip straight to polling
it instead of erroring or issuing a redundant call.

`create()`:
1. Skips `ModifyVolume` if a matching in-flight modification already exists.
2. Otherwise captures the pre-resize size and calls `ModifyVolume`.
3. Polls `DescribeVolumesModifications` until `ModificationState` reaches
   `"optimizing"` **or** `"completed"` — see the judgment call below. A
   `"failed"` state during the poll fails immediately, not after a timeout.
4. **Stops here** unless the SSM params are both set.
5. If they are, runs the SSM sub-step described above and records
   `osResizePerformed: true`/`false` in outputs.

## Judgment call: `"optimizing"` vs `"completed"`

This integration treats `ModificationState: "optimizing"` as sufficient to
declare the AWS-side resize done, per the docs' own example response
(`optimizing`, `progress: 40`) showing a volume that is already fully usable
— Elastic Volumes changes apply without unmounting. Waiting for `"completed"`
instead is a legitimate, more conservative alternative; it would just add a
potentially long, unnecessary wait for large volumes. If you need the fully
conservative behavior, that's a one-line change to the poll predicate in
`steps/resize.ts`.

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `VOLUME_ID` | must already exist |
| `TARGET_SIZE_GIB` | whole GiB, must be `>=` current size |
| `VOLUME_TYPE`, `IOPS`, `THROUGHPUT` | optional, passed to `ModifyVolume` only if set |
| `SSM_DOCUMENT_NAME`, `SSM_INSTANCE_ID` | optional, both-or-neither — opts into the in-OS grow sub-step |

## Gotchas

**Rollback cannot undo this.** EBS has no shrink API — once the resize
reaches `optimizing`/`completed`, the size increase is permanent. Rollback
only logs a loud warning; it makes no API calls. If the SSM sub-step ran,
that is not reversible either (shrinking a live filesystem is its own
hazardous, unsupported operation).

**Verification never claims more than was done.** `verify()` always
confirms the volume's `Size` matches the target. It only checks the SSM
command's final status if the sub-step actually ran — it never attempts to
introspect the guest OS's filesystem size itself.
