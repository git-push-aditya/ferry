# `aws/ec2/terminate-instance`

Terminates an EC2 instance. **This is irreversible** — once an instance is
terminated, it cannot be recovered by any AWS API, and a replacement instance
would get a new instance id regardless.

```bash
bun run bin/ferry.ts aws/ec2/terminate-instance --dry-run
bun run bin/ferry.ts aws/ec2/terminate-instance
```

## What it does

`check()` maps the create-or-skip contract onto a delete, mirroring
`aws/s3/delete-empty-bucket`: the instance already being `terminated` (or
fully purged) is `"exists"` (the target state — gone — already achieved, so
a re-run after a successful terminate is a clean no-op). Present in any
other state is `"missing"` (the terminate still needs to happen).

If `PRESERVE_VOLUME_CHECK=true` and the instance has an attached EBS volume
with `DeleteOnTermination=false`, `check()` reports `"conflict"` instead —
the run aborts in the plan phase, before anything is touched, rather than
silently proceeding with a terminate that would detach and preserve that
volume with no record of the connection.

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `INSTANCE_ID` | must already exist |
| `PRESERVE_VOLUME_CHECK` | `"true"`/`"false"`, default `false` |

## Gotchas

**Rollback cannot undo this.** `terminated` is genuinely terminal — the
root volume is deleted by default, instance-store data is erased, and there
is no restart path. Rollback, if triggered because a *later* step in the
same run failed after this one terminated the instance, only logs a loud
warning that the instance cannot be recovered; it takes no action. A run
that finds the instance already terminated never reaches this path at all
(the engine only rolls back steps that actually ran `create()`).

**The pre-terminate snapshot in the report is informational only.** AMI,
instance type, subnet, security groups, and tags are captured before the
terminate call purely for the markdown report — they are never used to
reconstruct anything.

**Won't silently strand a volume.** With `PRESERVE_VOLUME_CHECK=true`, an
attached volume configured not to delete on termination stops the run
instead of proceeding past it quietly.
