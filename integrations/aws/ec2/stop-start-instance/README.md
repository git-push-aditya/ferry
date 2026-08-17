# `aws/ec2/stop-start-instance`

Stops or starts an existing EC2 instance, confirmed with a polled state
read-back. Does not launch the instance; run `aws/ec2/launch-instance` first
if it doesn't exist yet.

```bash
bun run bin/ferry.ts aws/ec2/stop-start-instance --dry-run
bun run bin/ferry.ts aws/ec2/stop-start-instance
```

## What it does

| Step | Notes |
| --- | --- |
| `stop-start-instance` | stops or starts the instance per `ACTION`, using the shared `stopInstance`/`startInstance` helpers from `src/providers/aws/ec2.ts` |
| `verify` | polls the instance state until it confirms the requested destination (`stopped` for `stop`, `running` for `start`) |

## Design note: one integration, two directions

This is deliberately a single two-way toggle (`ACTION: "stop" | "start"`),
not two separate `stop-instance`/`start-instance` integrations. That's a
slight departure from the usual one-integration-per-verb pattern the S3
integrations follow (e.g. separate `update-bucket-versioning` and
`update-bucket-encryption`, not one combined toggle) — kept here because the
plan's own task list names this task singular (`stop-start-instance`), and
stop/start are exact mirror images of the same transition rather than two
independently-useful operations.

## Gotchas

**Transitional states are never touched.** `pending`, `stopping`, and
`shutting-down` all report as `"conflict"` in the plan phase — this
integration never acts mid-transition. A `terminated` instance is also a
`"conflict"`: there is nothing left to stop or start.

**Rollback is a genuine undo here**, unlike `terminate-instance`. Both
`stopped → running` and `running → stopped` are ordinary, fully-reversible
lifecycle transitions, so rollback simply reverses whichever direction this
run actually took, using the same shared stop/start helpers.

**Shared helpers, not duplicated logic.** This integration and
`aws/ec2/update-instance-type` both call the same `stopInstance`/
`startInstance` functions in `src/providers/aws/ec2.ts` rather than each
reimplementing `StopInstances`/`StartInstances` + polling.
