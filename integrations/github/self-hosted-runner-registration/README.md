# `github/self-hosted-runner-registration`

Registers a GitHub Actions self-hosted runner and launches the EC2 instance
that runs it — and proves it worked by waiting for the runner to report
`online`.

```bash
bun run ferry github/self-hosted-runner-registration -- --dry-run
bun run ferry github/self-hosted-runner-registration
```

## Steps

| Step | Behavior |
| --- | --- |
| `runner-instance-role` | creates the IAM role EC2 assumes, with an `ec2.amazonaws.com` trust policy and **no permissions** |
| `runner-instance-profile` | creates the instance profile and attaches the role |
| `runner-registration` | `POST .../generate-jitconfig` — registers the runner, captures its id and config |
| `launch-runner-instance` | launches the instance with the JIT config in `UserData` and the profile attached |
| `verify` | polls until GitHub reports the runner `online` |

## Gotchas

**Use an AMI with the runner binary pre-installed.** This is the single most
likely cause of an intermittent failure here. A JIT config's validity window is
meaningfully tighter than the legacy registration token's hour, and every
second spent downloading and installing a runner on boot is a second that
credential is ticking down. The `UserData` script this integration writes is
deliberately three lines: `cd`, then `run.sh --jitconfig`. If you install on
boot instead, expect this to work on a fast day and fail on a slow one.

**`check()` never calls `generate-jitconfig`.** That endpoint is *mutating and
single-use* — it registers a runner as a side effect and returns a credential
that cannot be reissued. The engine treats `check()` as a safe repeatable read
and calls it during `--dry-run`, so calling it there would register a real
runner during a plan. Presence is checked with `GET .../actions/runners`
filtered by name instead. **Do not "optimize" this.**

**There is no in-place update.** A JIT config cannot be reissued for an
already-registered runner, so drift correction is structurally
terminate-and-recreate rather than document-replace. This integration does not
do that automatically: deregister the runner and re-run. Same human-gated
honesty as `snowflake/rotate-user-key-pair`'s cutover.

**The role is created with zero permissions, on purpose.** A self-hosted runner
executes arbitrary workflow code. What it may do in AWS is a decision for
whoever operates it, and a generous default here would be genuinely dangerous.
Attach a scoped policy with `aws/iam/role/create-inline-policy-for-role`.

**EC2 needs an instance *profile*, not a role.** The console creates the
profile implicitly and only ever shows you the role, which makes this an easy
thing to miss when doing it by hand. Both are created here.

**Runner names are not unique.** GitHub does not enforce uniqueness, so
`RUNNER_NAME` is a convention this integration relies on rather than a
guarantee. A re-run that races a slow-but-still-succeeding earlier run could
register a second runner under the same name, if `check()` lands before the
first run's registration does. Low probability, real, and not claimed to be
impossible.

## Rollback order

Rollback unwinds LIFO: terminate the instance, deregister the runner, detach
and delete the profile, delete the role.

`docs/plan/aws-github.md` §7 recommends deregistering *before* terminating, on
the reasoning that the runner id cannot be recovered once the instance is gone.
That holds for a human working by hand, but not here — the id lives in
`ctx.outputs`, which rollback closures capture and which outlives every step.
So LIFO is correct and safe, and deviating from it would mean special-casing
rollback order inside the engine, which is exactly what the
folder-per-integration model exists to avoid.

## Verification boundary

The `online` poll is the real proof: it is the only signal that the whole chain
worked — profile attached, cloud-init ran, JIT config still valid, agent
reached GitHub. Anything weaker cannot tell "we launched a box" from "we have a
working runner".

If this run skipped registration because the runner already existed, verify
says so and skips the poll rather than passing quietly on someone else's runner.
