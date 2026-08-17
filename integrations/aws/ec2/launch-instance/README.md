# `aws/ec2/launch-instance`

Launches exactly one EC2 instance, tagged with a `ferry:integration-id` /
`ferry:logical-name` pair so a re-run finds it (and skips) instead of
launching a second one. Proven with a live poll to `running` plus a status
check reaching `ok`, not just trusted from `RunInstances`'s own response.

```bash
bun run bin/ferry.ts aws/ec2/launch-instance --dry-run
bun run bin/ferry.ts aws/ec2/launch-instance
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `launch-instance` | one EC2 instance | Identity is a tag pair, not a name — EC2 has no natural global-uniqueness probe the way S3 bucket names do |
| `verify` | polls until `running` and status checks report `ok` | A status-check timeout warns, it does not fail the run |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `LOGICAL_NAME` | the `ferry:logical-name` identity tag `check()` matches on |
| `AMI_ID` | must already exist |
| `INSTANCE_TYPE` | e.g. `t3.micro` |
| `SUBNET_ID` | must already exist |
| `SECURITY_GROUP_IDS` | comma-separated, must already exist |
| `KEY_PAIR_NAME` | optional — omit for a keyless launch |
| `CLIENT_TOKEN_OVERRIDE` | optional — forces reuse of a specific `ClientToken` |
| `TAGS` | optional JSON object of extra tags |

## Reuses vs creates

Identity here is a tag, not a name: `check()` looks for a live (non-terminal)
instance carrying this integration's `ferry:integration-id` +
`ferry:logical-name` tags. No match — `"missing"`, launches one. A match —
`"exists"`, skipped, no rollback registered. Per the `StepState` contract,
`check()` is a shallow presence probe, not drift detection: a matching,
already-tagged instance whose AMI/type/subnet diverge from this run's params
is still `"exists"`, never `"conflict"`.

## Gotchas

**This integration can never *change* an already-launched instance's
type/AMI/subnet.** Once `check()` reports `"exists"`, this run does nothing
further to that instance — no diff, no reconcile. Changing instance type is
a different, not-yet-built task (`update-instance-type`); changing AMI or
subnet isn't covered anywhere in this project, since either would require
replacing the instance outright, not modifying it in place.

**Rollback terminates the instance.** Only reached if this run's own
`create()` launched it and a later step in the same run failed — a reused
(`"exists"`) instance is never rolled back. Rollback tolerates the instance
already being gone (`InvalidInstanceID.NotFound`).

**Ordering is a real precondition, not something this integration manages.**
The AMI, subnet, and security group(s) must already exist — this integration
never creates any of them.
