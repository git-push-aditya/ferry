# aws/ec2 — Implementation Plan

This document plans 12 `aws/ec2` integrations against Ferry's existing step
contract (`src/core/define.ts`, `src/core/engine.ts`, `src/core/wait.ts`) and
the conventions already established in `aws/s3` (`ensureBucketState`-style
guard steps, "always-reconcile self-idempotent" whole-document-replace steps,
the "inverted create-or-skip" pattern for delete/terminate-type steps,
multi-step orchestration with explicitly undocumented non-mirrored settings).
No code — English-language algorithm steps only.

Every factual claim below (idempotency behavior, state machines, API
constraints) was verified against `docs.aws.amazon.com` during drafting and
re-verified in the sanity-check pass at the end of each section. Two
citations recur throughout and are abbreviated:

- **EC2 idempotency page** — `AWSEC2/latest/APIReference/Run_Instance_Idempotency.html`.
  Confirms: `TerminateInstances`, `AssociateAddress`, `DisassociateAddress`
  are idempotent **by default** (no token needed). `RunInstances` is
  idempotent **only if you supply `ClientToken`**, and only within the
  Regional/zonal scope the token was issued for; a retry with the same token
  but different parameters fails with `IdempotentParameterMismatch`.
- **Instance lifecycle page** — `AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html`.
  States: `pending → running → stopping → stopped` (reversible: `stopped`
  can restart via `pending → running`) and `shutting-down → terminated`
  (terminal — "You can't connect to or recover a terminated instance").

---

## 1. launch-instance

**check()** — Does an instance matching this integration's identity already
exist? EC2 has no natural equivalent of S3's global-uniqueness probe, so
identity here is a tag, not a name: check for a running/stopped instance
carrying a `ferry:integration-id` + `ferry:logical-name` tag pair (via
`DescribeInstances` with a tag filter). No match → `"missing"`. A live match
whose AMI/instance-type/subnet/security-group diverge from params is still
`"exists"` — per the `StepState` contract, `check()` is a shallow
presence/ownership probe, not a drift detector, so a param mismatch on an
existing tagged instance is not surfaced as `"conflict"`; it's simply out of
scope (this integration doesn't diff running config, matching how S3's
`update-bucket-region` explicitly declines to diff either). A match owned by
tags this run doesn't control (e.g. same logical name, different
`ferry:managed-by` marker) → `"conflict"`.

**reconcile()** — N/A; this is a create-only step (no reconcile needed once
tagged and present — see step decomposition below for why launch is one
step, and `tag-instance` is a separate integration for later edits).

**create()** —
1. Generate (or accept from params) a `ClientToken` and call `RunInstances`
   with `ImageId`, `InstanceType`, `MinCount=1`, `MaxCount=1`, `SubnetId`,
   `SecurityGroupIds`, the `ClientToken`, and a `TagSpecification` for
   `ResourceType=instance` carrying `ferry:integration-id`,
   `ferry:logical-name`, plus any user-supplied tags — applying tags at
   launch avoids the separate `CreateTags` call and its own eventual-
   consistency window.
2. `pollUntil` (src/core/wait.ts) on `DescribeInstances` until
   `State.Name == "running"` (verified: `pending → running` per the
   lifecycle page) — not just a 200 from `RunInstances`, since the instance
   is `pending` immediately after the call returns.
3. Capture `instanceId`, `privateIp`, `availabilityZone`, and the
   `ClientToken` used (needed so a re-run after a partial failure retries
   idempotently rather than launching a second instance) into `ctx.outputs`.

**rollback()** — `TerminateInstances` on the captured `instanceId`, then
`pollUntil` until `State.Name == "terminated"`. Verified idempotent by
default (EC2 idempotency page) — a rollback that races a user's own manual
terminate is a safe no-op, not a double-delete error.

**Idempotency** — The `ClientToken` is the load-bearing mechanism: if
`create()` throws after `RunInstances` succeeded but before the poll
confirms `running` (network blip, process killed), a re-run's `check()`
will now find the tagged instance and report `"exists"` — no `create()`
runs again, so the token is actually a belt-and-suspenders guard against a
narrower race (this run's own retry before the tag is even queryable, e.g.
inside the same `retryWithBackoff` attempt loop around the initial
`RunInstances` call itself, per `retryWithBackoff`'s "eventual-consistency
read-after-write" rationale).

**Determinism** — Exactly one instance per run (`MinCount=MaxCount=1`);
no ordering ambiguity to resolve.

**Ordering** — Real precondition, not a cycle: assumes the AMI, subnet, and
security group already exist (subnet/AMI come from other phase-2 AWS
integrations or a user's existing VPC; `create-security-group`, below, is
this project's own path to a security group id). `launch-instance` does not
create any of its three dependencies — mirroring `delete-bucket-with-
transfer`'s refusal to silently create a destination bucket.

**verify()** — `DescribeInstances` shows `State.Name == "running"` and
`StatusCheckSummary` (from `DescribeInstanceStatus`) eventually reaching
`ok` — poll with a generous timeout since status checks can lag boot by up
to a few minutes; a timeout here logs a warning (per `pollUntil`'s "give up
and proceed" contract) rather than failing verify, since a slow-booting-but-
otherwise-fine instance shouldn't fail the whole run.

**Configurable params** — AMI id, instance type, subnet id, security group
id(s), key pair name (optional), additional user tags, `ClientToken`
override (for tests / forced-idempotent replay).

**Step decomposition** — One step. A single instance launch is one aggregate
action (RunInstances + tag + poll), not N named sub-resources with
independent rollback identity — same reasoning as `delete-bucket-with-
transfer`'s single aggregate step for N objects. `resource()` reports
`{ type: "aws_ec2_instance", attributes: { instanceId, availabilityZone,
privateIp } }`.

### Sanity check

`RunInstances`'s idempotency-via-`ClientToken` and the exact
`pending → running` transition are both re-confirmed against the fetched
docs; no change needed. One open scope question, flagged rather than
silently resolved: `check()` treating an existing tagged instance with
drifted params as `"exists"` (not `"conflict"`) is consistent with this
project's "check() is shallow, not drift detection" rule, but it does mean
`launch-instance` can never be used to *change* an already-launched
instance's type/AMI/subnet — that's `update-instance-type` (task 12) and,
for AMI/subnet, out of scope entirely (would require replace-not-modify,
which no task here covers). Worth a one-line README callout when built.

---

## 2. terminate-instance

**check()** — Inverted create-or-skip, mirroring `delete-empty-bucket`:
`DescribeInstances` on the given `instanceId`. Already `terminated` (or the
id 404s as fully purged) → `"exists"` (target state — gone — already
achieved; re-run after a successful terminate is a clean no-op). Present in
any non-terminal state → `"missing"` (the terminate still needs to happen).
If the optional "no active EBS volumes to preserve" guard is configured and
finds an attached volume with `DeleteOnTermination=false` that the params
didn't explicitly acknowledge, that guard reports the state as
`"conflict"` — abort before the plan phase promises a run that would
silently strand a volume (a straight terminate would detach and preserve
it, so nothing is lost technically, but data ownership becomes ambiguous
with no record of the connection — the same "don't silently do something
the user didn't ask for" instinct as never auto-emptying a bucket).

**reconcile()** — N/A; terminate is create-or-skip like delete-empty-bucket,
not create-then-reconcile.

**create()** — Named `create()` per the Step contract even though
conceptually this is the "do the delete" branch (only runs when `check()`
returned `"missing"`, i.e. instance still exists):
1. `TerminateInstances` on `instanceId`.
2. `pollUntil` until `State.Name == "terminated"` (verified terminal —
   "can't connect to or recover a terminated instance").
3. Record in `ctx.outputs` the pre-terminate instance snapshot (AMI id,
   instance type, subnet, security groups, tags) purely for the markdown
   report — **not** for rollback, since termination cannot be undone.

**rollback()** — None meaningful. `terminated` is a one-way transition
(lifecycle page: root volume deleted by default, instance store data
erased, no restart path) — same as `delete-empty-bucket`'s "best-effort,
not a real restore" gotcha, except here it's worse: there is no
`CreateBucket`-equivalent "recreate a same-named empty shell" move, because
a new instance would get a new `instanceId`. `rollback()` therefore only
logs a loud warning that termination is irreversible; it registers no undo
action. Because the engine only calls `rollback()` for steps that actually
ran `create()`/`reconcile()` (never for `"exists"`/skip), a run that only
found an already-terminated instance never reaches this warning path.

**Idempotency** — `TerminateInstances` verified idempotent by default (no
`ClientToken` needed) — re-running against an already-terminating instance
is safe. Combined with `check()` treating `terminated` as `"exists"`, a
re-run after an interrupted terminate-then-poll simply re-observes the
terminal state.

**Determinism** — Single instance id, no ordering ambiguity.

**Ordering** — Depends on the instance already existing — real precondition
from `launch-instance` or any pre-existing instance the user points this
at; this integration never creates one.

**verify()** — `DescribeInstances` (or its 404-after-a-while) confirms
`terminated`. Note the docs' "remains visible in the console for a short
while, and then the entry is automatically deleted" — verify should accept
either `State.Name == "terminated"` while still describable, or an
`InvalidInstanceID.NotFound` on the same call as an equally valid confirm,
since a very fast run could land after AWS has already dropped the record.

**Configurable params** — instance id, `preserveVolumeCheck: boolean`
(enables the guard in `check()`), optional pre-terminate snapshot toggle
(convenience flag that internally composes `create-ebs-snapshot`'s logic —
noted as a future composition, not built here to keep this task scoped to
termination itself).

**Step decomposition** — One step. `resource()` reports
`{ type: "aws_ec2_instance", attributes: { instanceId } }` with
`action: "reconciled"` in the registry even though semantically this is a
delete — same representational choice the engine already makes for
`delete-empty-bucket` (the engine's `recordChange` only distinguishes
`"created"` vs `"reconciled"`, not `"deleted"`; the S3 delete tasks report
under `"reconciled"` too).

### Sanity check

Re-confirmed against the lifecycle page: `terminated` is genuinely terminal,
so "rollback is a no-op with a warning" is not a hedge, it's the only
correct answer — flagging this explicitly rather than pretending rollback
does something is deliberate, mirroring how `delete-empty-bucket`'s README
is upfront about the same limitation. The "no active EBS volumes to
preserve" guard is a judgment call about what counts as a conflict; an
alternative design would make it a plain warning instead of a plan-phase
abort. Kept as `"conflict"` here because terminate is destructive and
irreversible, so erring toward "stop and ask" beats "warn and proceed."

---

## 3. stop-start-instance

**check()** — `DescribeInstances` on `instanceId`. The desired action
(`stop` or `start`, a param) determines what "missing" means: for
`action=stop`, current state `running` → `"missing"` (needs stopping);
already `stopped` → `"exists"`. For `action=start`, `stopped` → `"missing"`;
already `running` → `"exists"`. Any transitional state (`pending`,
`stopping`, `shutting-down`) or `terminated` → `"conflict"` — never start a
terminating instance or stop a booting one; let the transition finish (or,
for `terminated`, abort entirely — there is nothing to stop or start).

**reconcile()** — N/A; this is a create-or-skip toggle, not a document-
replace reconcile.

**create()** —
1. For `action=stop`: `StopInstances`, then `pollUntil` until
   `State.Name == "stopped"`.
2. For `action=start`: `StartInstances`, then `pollUntil` until
   `State.Name == "running"`.
3. Record the pre-action state in `ctx.outputs` (needed for rollback).

**rollback()** — Reverse the transition: if this run stopped the instance,
rollback calls `StartInstances` and polls to `running`; if this run started
it, rollback calls `StopInstances` and polls to `stopped`. Both directions
are real, reversible transitions per the lifecycle page (`stopped` can
always restart; `stopping→stopped` from `running` is equally standard) —
unlike `terminate-instance`, this task's rollback is a genuine undo, not a
best-effort warning.

**Idempotency** — Neither `StopInstances` nor `StartInstances` is on the
EC2 idempotency page's "idempotent by default" or "client-token" lists, but
`check()` reporting the target state as `"exists"` once reached makes the
overall step idempotent at the Ferry level: a re-run against an instance
already in the target state is a clean skip, matching the project's general
pattern of pushing idempotency to `check()` rather than relying on the raw
API call being literally re-callable without side effects.

**Determinism** — Single instance, single target state; no ordering
ambiguity within the step.

**Ordering** — Depends on the instance already existing (precondition, not
a cycle). This step is also the shared building block `update-instance-type`
composes (see task 12) — see that task's note on whether that's duplication
or intentional reuse.

**verify()** — `DescribeInstances` confirms the target `State.Name`
matches the requested action's destination state.

**Configurable params** — instance id, `action: "stop" | "start"`.

**Step decomposition** — One step, single instance, single transition —
no factory needed (contrast with `update-security-group-rules`, task 5,
which genuinely is N items).

### Sanity check

Lifecycle-page transitions re-checked: `stopped → pending → running` and
`running → stopping → stopped` are both ordinary, reversible, fully-
documented transitions — no caveats here, unlike `terminate-instance`.
One structural note: keeping `stop-start-instance` as a single two-way
toggle (rather than two separate integrations `stop-instance` /
`start-instance`) was a judgment call favoring "one step, parameterized
action" over "two near-identical integrations" — consistent with this
task list's own naming (`stop-start-instance`, singular), but worth
flagging since it's a slight departure from the one-integration-per-verb
pattern the S3 examples follow (e.g. separate `update-bucket-versioning`
vs `update-bucket-encryption`, not one combined "update-bucket-toggle").

---

## 4. create-security-group

**check()** — `CreateSecurityGroup`'s own docs confirm names are unique
per-VPC ("You can't have two security groups for the same VPC with the
same name"), so this is the same three-way shape as `ensureBucketState`,
scoped to a VPC instead of globally: `DescribeSecurityGroups` filtered by
`group-name` + `vpc-id`. No match → `"missing"`. A match tagged as owned by
this integration (`ferry:integration-id` tag, applied at creation via
`TagSpecification` on `CreateSecurityGroup`) → `"exists"`. A same-named
group in that VPC *not* carrying this run's ownership tag → `"conflict"` —
same discipline as S3's bucket-ownership check: existence without proven
ownership must never be silently adopted.

**reconcile()** — N/A for the group's identity itself (name/VPC don't
change once created — recreating under a new name is a different
integration's job). The starting rule set is applied only at creation
time, in `create()`; **ongoing** rule changes are `update-security-group-
rules`'s job (task 5) — kept as a separate integration rather than folded
in here, deliberately: creating a group and mutating its live rule set are
different operations with different re-run semantics (create-or-skip vs.
always-reconcile), and conflating them would force `create-security-group`
into the always-reconcile shape for no benefit, since a security group's
starting rules are a one-time bootstrap concern.

**create()** —
1. `CreateSecurityGroup` with `GroupName`, `GroupDescription`, `VpcId`, and
   a `TagSpecification` carrying the ownership tag.
2. For each starting ingress/egress rule in params, `AuthorizeSecurityGroup
   Ingress` / `AuthorizeSecurityGroupEgress` with the rule's protocol/port/
   CIDR-or-source-group. (Verified: exactly one of CIDR/prefix-list/source-
   group must be specified per rule, and protocol is mandatory; the docs
   note port is required for tcp/udp and ICMP type/code for icmp.)
3. `pollUntil` a `DescribeSecurityGroups` read-back shows the expected rule
   count — an eventual-consistency guard per the docs' own "propagated…
   however, a small delay might occur."
4. Capture `groupId` in `ctx.outputs`.

**rollback()** — `DeleteSecurityGroup` on the captured `groupId`. Safe
because the whole group (rules included) is this run's creation; no
partial-rule rollback bookkeeping needed since the group itself is the unit
of rollback. (If the group is already referenced by a running instance's
`SecurityGroupIds`, `DeleteSecurityGroup` will fail with `DependencyViolation`
— rollback should catch and warn rather than throw, since the engine's own
rollback runner must not itself throw mid-unwind.)

**Idempotency** — Re-running after a partial-rule failure: `check()` will
find the tagged group already `"exists"` (group creation itself is done),
but the "apply starting rules" work happened inside `create()`, which only
runs on `"missing"`. This is a real gap worth flagging (see sanity check):
a group that exists but has an incomplete rule set from an interrupted
first run will read as fully `"exists"` and reconcile() is undefined, so
the missing rules are never retried. Mitigation: make rule-authorization
idempotent-safe (`AuthorizeSecurityGroupIngress` errors on an exact
duplicate rule, confirmed by the docs' CIDR-canonicalization note, so a
retry of an already-applied rule must catch and ignore
`InvalidPermission.Duplicate` specifically) and, more robustly, give this
step a `reconcile()` too — not just `create()` — that re-diffs the starting
rule set against the live group every run, self-idempotently (an
"always-reconcile" step for the rule *set*, layered under the create-or-
skip step for the group's *existence*). This plan adopts that two-layer
design: `create()` handles group existence, `reconcile()` (which the engine
runs whenever `create()` did not) re-applies any starting rules still
missing.

**Determinism** — Rule application order doesn't matter (each rule is
independent); only the final rule set matters, checked at verify().

**Ordering** — Depends on the VPC existing (external precondition, not
created by Ferry here). No dependency on any other EC2 task in this list —
security groups can be created before or after instances exist, since
association happens at launch time or via `ModifyInstanceAttribute`'s
`GroupId.N` (used by nothing in this list currently, but noted as the API
that would back a hypothetical "attach-security-group-to-instance" task).

**verify()** — `DescribeSecurityGroups` shows the group present with the
expected starting rule set (as a set-equality check, not order-sensitive).

**Configurable params** — group name, description, VPC id, list of starting
ingress rules, list of starting egress rules (each: protocol, port/range,
CIDR or source-group-id).

**Step decomposition** — One step for the group, with the starting rule
list handled as an internal loop inside that one step's `create()`/
`reconcile()` — not N sub-steps. Reasoning: the rules aren't independently
identified resources with their own rollback identity outside this group's
existence (deleting the group deletes all its rules atomically); this
mirrors `create-bucket`'s multi-factory composition being about composing
*different concerns* (bucket + versioning + encryption), not about
fanning a single concern out into N steps. `resource()` reports
`{ type: "aws_security_group", attributes: { groupId, vpcId, ruleCount } }`.

### Sanity check

`CreateSecurityGroup`'s per-VPC uniqueness and `AuthorizeSecurityGroup
Ingress`'s duplicate-CIDR-canonicalization behavior are both directly off
the fetched docs. The real design tension flagged above — create() vs.
reconcile() covering the starting rule set — is genuine and this plan
resolves it in favor of giving the step both, which is a deliberate
deviation from a pure create-or-skip shape; call this out during review,
since it means `create-security-group` isn't a clean single-branch step
like `launch-instance`.

---

## 5. update-security-group-rules

**check()** — `DescribeSecurityGroups` on the given `groupId`. `"missing"`
if the group doesn't exist at all (this integration never creates one —
same non-auto-create discipline as `delete-bucket-with-transfer`'s
destination-bucket check) — actually reported as `"conflict"`, not
`"missing"`, since there is no `create()` path here at all: every rule
change is a reconcile against a group that must already exist. `"exists"`
whenever the group is present, regardless of its current rule set — the
mismatch between "current rules" and "desired rules" is exactly what
`reconcile()` resolves, not `check()` (again, `check()` is shallow
presence, not a diff).

**reconcile()** — Always-reconcile, self-idempotent, same shape as
`s3VersioningStep`/`s3BucketExistsGuardStep`'s sibling pattern for whole-
document-replace APIs — except a security group's rule set isn't a single
PUT, so the diff has to be computed and applied as add/remove:
1. `DescribeSecurityGroupRules` (or `DescribeSecurityGroups`'s embedded
   `IpPermissions`/`IpPermissionsEgress`) to read the live rule set.
2. Diff live vs. desired (from params): rules present live but not desired
   → revoke list; rules desired but not live → add list. Diffing is by
   full rule tuple (protocol, port range, and exactly one of CIDR/prefix-
   list/source-group — matching the "specify exactly one" constraint the
   Authorize docs verify), not by some partial key, so a rule that changed
   only its port range is one revoke + one add, not an in-place edit (no
   such edit API exists for security group rules).
3. `RevokeSecurityGroupIngress` / `RevokeSecurityGroupEgress` for the
   revoke list, batched into one call each (both APIs accept an
   `IpPermissions.N` array).
4. `AuthorizeSecurityGroupIngress` / `AuthorizeSecurityGroupEgress` for the
   add list, batched similarly; catch and ignore
   `InvalidPermission.Duplicate` (a race with a concurrent manual change,
   or a rule already present from an interrupted prior reconcile).
5. `pollUntil` a fresh `DescribeSecurityGroupRules` read-back matches the
   full desired set — the same eventual-consistency guard as task 4.
6. Capture the pre-reconcile rule set (the revoke list, specifically) in
   `ctx.outputs` so `rollback()` can restore exactly what was removed.

**rollback()** — Re-`Authorize` whatever this run revoked, and re-`Revoke`
whatever this run added — i.e. replay the diff in reverse using the
captured pre-image, restoring the group to its exact prior rule set. This
is a real, precise rollback (unlike `terminate-instance`'s), because
security group rules are fully reversible with no data loss.

**Idempotency** — The diff-then-apply shape means a re-run after an
interrupted reconcile recomputes the diff fresh against whatever the live
state actually is, so it naturally converges to the desired set regardless
of how far a prior attempt got — this is the textbook "always-reconcile,
self-idempotent" property, just implemented as a diff instead of a single
PUT because the SG rule API has no whole-document-replace call.

**Determinism** — The diff (revoke-list, add-list) is computed once from a
single live read, so it's stable within a run; rule order within each
batched Authorize/Revoke call doesn't matter since each rule is independent.

**Ordering** — Depends on the security group already existing — from
`create-security-group` (task 4) or any pre-existing group. Real
precondition, not a cycle: this task deliberately never creates a group,
mirroring `delete-bucket-with-transfer`'s refusal to create its
destination.

**verify()** — Live `DescribeSecurityGroupRules` set-equals the desired
rule set from params.

**Configurable params** — group id, desired ingress rule list, desired
egress rule list (each rule: protocol, port/range, CIDR or source-group).

**Step decomposition** — One aggregate step over the rule list, not one
step-factory instance per rule. This is the sharpest contrast case in this
plan: N named resources with independent identity (the `create-bucket`-
style step-factory pattern) fits things like N IAM policies each with their
own ARN and rollback; a security group's rule set is a single mutable
collection with no per-rule identity outside "is this exact tuple present,"
so it's naturally one always-reconcile step over the whole set — same
reasoning `delete-bucket-with-transfer` used to justify one step over N
objects rather than N steps. `resource()` reports
`{ type: "aws_security_group_ruleset", attributes: { groupId, ingressCount,
egressCount } }`.

### Sanity check

`AuthorizeSecurityGroupIngress`'s duplicate-rule and CIDR-canonicalization
behavior, and the "exactly one of CIDR/prefix-list/source-group per rule"
constraint, are directly off the fetched docs and drive the diff-key
choice above. One genuine scope question: this task and `create-security-
group`'s `reconcile()` (task 4, per its own sanity check) now both touch
the group's rule set — worth deciding, when building, whether `create-
security-group`'s reconcile should simply delegate to this task's diff
logic (shared helper) rather than duplicating it, to avoid two independent
implementations of the same add/remove diff drifting apart.

---

## 6. attach-detach-ebs-volume

**check()** — `DescribeVolumes` on `volumeId` to read `Attachments`. For
`action=attach`: already attached to the given `instanceId` at the given
device → `"exists"`; attached to a *different* instance → `"conflict"`
(never silently detach-and-reattach — that's a distinct, more destructive
operation the user didn't ask for); volume `available` (unattached) →
`"missing"`. For `action=detach`: already detached (`available`) →
`"exists"`; attached to the given instance → `"missing"`; attached to a
different instance than named in params → `"conflict"`.

**reconcile()** — N/A; attach/detach is a create-or-skip toggle per
direction, same shape as `stop-start-instance`.

**create()** —
1. For `action=attach`: verify volume and instance are in the same
   Availability Zone (a hard `AttachVolume` constraint per the docs —
   surfacing this as an early, clear error rather than letting the raw API
   4xx do it) and that the instance is `running` or `stopped` (verified:
   AttachVolume accepts either). Call `AttachVolume` with `VolumeId`,
   `InstanceId`, `Device`. `pollUntil` until the attachment `status ==
   "attached"`.
2. For `action=detach`: if the target volume is the instance's **root**
   volume, require the instance to already be `stopped` — verified hard
   constraint ("If an EBS volume is the root device of an instance, it
   can't be detached while the instance is running. To detach the root
   volume, stop the instance first."); if it's running, this is a
   `"conflict"` at `check()` time, not something `create()` tries to fix by
   stopping the instance itself (composing a stop is `stop-start-
   instance`'s job — this task doesn't reach across into another
   integration's action, matching the "precondition, not auto-chained"
   discipline seen in `update-bucket-region` deliberately not mirroring
   bucket settings). Call `DetachVolume` with `VolumeId`, `InstanceId`,
   `Device`. `pollUntil` until `status == "detached"` (or the volume state
   becomes `available`).

**rollback()** — Reverse direction: if this run attached, rollback detaches
(same device); if this run detached, rollback re-attaches at the same
device it was detached from (captured in `ctx.outputs` at reconcile time).
Both directions are real, standard, reversible operations for a non-root
data volume. For a root-volume detach (only possible against a stopped
instance per the constraint above), rollback re-attaches at the same
device — also standard, no data loss, since detach/attach never touches
volume contents.

**Idempotency** — Neither Attach/DetachVolume are on the EC2 "idempotent
by default" or client-token lists, so — same as `stop-start-instance` —
idempotency is pushed to `check()`: a re-run against a volume already in
the target attachment state is a clean skip.

**Determinism** — Single volume, single instance, single device path per
run; no fan-out.

**Ordering** — Real precondition, not a cycle: assumes both the instance
(`launch-instance`) and the volume already exist. This task does not create
the volume — a `create-ebs-volume` integration is out of scope for this
plan (not in the list of 12); the params require an existing `volumeId`.

**verify()** — `DescribeVolumes` confirms the target attachment state
(`attached` at the specified device, or `available`/no attachment).

**Configurable params** — volume id, instance id, device name (e.g.
`/dev/sdf`), `action: "attach" | "detach"`, `force: boolean` (maps to
`DetachVolume`'s documented `Force` — surfaced as an explicit opt-in given
the docs' own warning that it "can lead to data loss or a corrupted file
system" and should only be used "as a last resort").

**Step decomposition** — One step, single volume/instance pair — no
factory needed.

### Sanity check

The root-volume-detach-requires-stopped constraint and the same-AZ
requirement for attach are both direct quotes from the fetched
`DetachVolume`/`AttachVolume` docs, so this is solid. One thing flagged
rather than silently assumed: `Force` detach's data-loss risk is real per
AWS's own wording, and this plan treats it as an explicit param rather than
a hidden default — reviewers should confirm that's the right default-off
posture before building.

---

## 7. create-ebs-snapshot

**check()** — Snapshots are point-in-time, not idempotent targets the way
"a bucket named X" is — there's no natural pre-existing-snapshot identity
to check for scratch. Model identity via a `ferry:integration-id` +
`ferry:run-marker` tag applied at snapshot creation (params can supply an
idempotency-relevant marker, e.g. a caller-supplied logical name, so a
retried run can find "did I already snapshot this volume for this reason"
via `DescribeSnapshots` filtered by that tag + `volume-id`). A matching
tagged snapshot in `pending` or `completed` state → `"exists"` (re-run
after an interrupted first attempt doesn't create a second snapshot). No
match → `"missing"`.

**reconcile()** — N/A; create-only.

**create()** —
1. `CreateSnapshot` with `VolumeId` and a `TagSpecification` carrying the
   identity tags plus any user-supplied description/tags. Verified: EBS
   allows snapshotting an attached, in-use volume directly (no need to
   detach or stop first) — "You can take a snapshot of an attached volume
   that is in use" — though the docs recommend stopping the instance first
   specifically when the volume is a **root device**, for a fully
   consistent snapshot; expose this as a `stopInstanceFirst: boolean`
   convenience param that, when true, composes `stop-start-instance`'s stop
   logic before the snapshot and its start logic after (an intentional
   shared-helper reuse, same question flagged for `update-instance-type`
   in task 12 — this plan resolves it the same way: shared helper, not
   duplicated polling logic).
2. `pollUntil` (long timeout — snapshot completion is proportional to
   volume size and change-rate since the last snapshot) via
   `DescribeSnapshots` until `State == "completed"`. Verified states:
   `pending | completed | error | recoverable | recovering` — an `error`
   state during the poll should fail fast rather than keep polling to
   timeout.
3. Capture `snapshotId` in `ctx.outputs`.

**rollback()** — `DeleteSnapshot` on the captured `snapshotId`. Real,
precise rollback — deleting a just-created snapshot loses nothing that
existed before this run.

**Idempotency** — The identity-tag lookup in `check()` is what makes this
idempotent at the Ferry level, since `CreateSnapshot` itself has no
`ClientToken` and isn't on the idempotent-by-default list — without the
tag-based lookup, a retried run would create a second, redundant snapshot.

**Determinism** — Single volume, single snapshot per run.

**Ordering** — Depends on the volume already existing (precondition).
Optionally composes `stop-start-instance`'s stop/start when
`stopInstanceFirst=true` and the volume is attached to a known instance —
real cross-task dependency, opted into per-run, not a hard requirement.

**verify()** — `DescribeSnapshots` confirms `State == "completed"` and
`VolumeId` matches the source.

**Configurable params** — volume id, description, tags,
`stopInstanceFirst: boolean` (+ instance id, required only if true).

**Step decomposition** — One step, one snapshot. `resource()` reports
`{ type: "aws_ebs_snapshot", attributes: { snapshotId, volumeId } }`.

### Sanity check

`CreateSnapshot`'s "can snapshot an attached, in-use volume" and its
recommendation to stop the instance specifically for root-volume snapshots
are both direct from the fetched docs — the `stopInstanceFirst` param is a
reasonable, clearly-optional response to that recommendation rather than a
hard requirement, which seems right since forcing a stop for every snapshot
would make this integration far more disruptive than the AWS API itself
requires.

---

## 8. resize-ebs-volume

**check()** — `DescribeVolumes` on `volumeId`: current `Size` already
`>=` the requested target size → `"exists"` (nothing to grow — also covers
the "already resized by a prior run" re-entry case). Current size `<`
target → `"missing"`. Verified constraint from `ModifyVolume`'s docs:
"the target volume size must be greater than or equal to the existing
size" — so a target smaller than current is not a valid request at all;
`check()` should treat that as a params validation error surfaced before
`"conflict"` even applies (this integration only grows, never shrinks —
shrinking a volume isn't an EBS operation in the first place). Also
verified: `ModifyVolume` requires the volume's last modification to be
`completed` and caps at 4 modifications per rolling 24h — if a prior,
still-in-flight modification exists (`modifying`/`optimizing`), that's
`"conflict"` (the plan-phase abort, before attempting a second concurrent
`ModifyVolume`, which the API itself would reject anyway).

**reconcile()** — N/A; grow-only, create-or-skip against the target size.

**create()** — This is the section the task explicitly asks to be honest
about a real AWS-side/in-OS boundary:
1. `ModifyVolume` with `VolumeId` and the target `Size` (and, only if
   explicitly requested, `VolumeType`/`Iops`/`Throughput` — kept optional
   since the task is specifically about size growth).
2. `pollUntil` via `DescribeVolumesModifications`, filtered to this
   `volumeId`, until `modificationState` reaches `"optimizing"` **or**
   `"completed"` — verified these are the two "done enough to use"
   states: the docs' own example shows `optimizing` with `progress: 40`
   as already a usable, in-progress-but-online state (Elastic Volumes
   changes apply without unmounting), while `completed` is the fully
   finished state. Treat `"failed"` as an immediate poll failure, not a
   timeout.
3. **Stop here.** The AWS-side resize is complete at this point, and this
   is the honest end of what `ModifyVolume`/`DescribeVolumesModifications`
   cover. The docs are explicit that this is a separate, subsequent step:
   "When you complete a resize operation on your volume, you need to
   extend the volume's file-system size to take advantage of the new
   storage capacity" (from `ModifyVolume`'s own docs, linking out to a
   distinct "Extend the file system" guide). AWS does **not** grow the
   partition or filesystem for you — that requires running commands
   *inside* the guest OS (`growpart`/`resize2fs`/`xfs_growfs` on Linux,
   Disk Management on Windows), which is a fundamentally different trust
   boundary (needs OS-level access, not just the AWS API credentials this
   integration otherwise uses).
4. Capture the pre-resize `Size` in `ctx.outputs` (for rollback/report) and
   record explicitly in outputs whether an in-OS grow step ran (see next
   point) — `osResizePerformed: boolean`.
5. **Optional, clearly bounded sub-step:** if params supply an
   `ssmDocumentName`/instance id for an SSM-based in-OS grow (rather than
   this integration silently assuming it can reach into the OS), run
   `SendCommand` via SSM Run Command with that document against the owning
   instance, and poll SSM's own command-status API until `Success` or
   `Failed`. If this optional path is not configured, `create()` stops at
   step 3 and the report/README say outright that filesystem growth is out
   of scope for this run and must be done manually or via a separate SSM
   run.

**rollback()** — There is no `ModifyVolume` "shrink back" — EBS volumes
cannot be shrunk via this API (sizes only grow), so rollback **cannot**
restore the prior size once the AWS-side resize has reached `optimizing`/
`completed`. Rollback here is the same honest limitation as
`delete-empty-bucket`'s: log a loud warning that the size increase is
permanent and cannot be rolled back by this tool; if the optional SSM
in-OS-grow sub-step ran, that step is also not reversible (shrinking a live
filesystem is its own hazardous, unsupported-by-this-project operation).

**Idempotency** — `check()`'s size comparison makes a re-run against an
already-resized volume a clean skip. Mid-flight interruption (this run's
process dies between `ModifyVolume` and the poll completing): a re-run's
`check()` sees current size still `<` target (the API call succeeded
server-side but the size hasn't landed yet, or is `modifying`) — that
reads as `"missing"` again, but per the rolling-24h/4-modifications and
"previous modification must be completed" constraints, a second
`ModifyVolume` call while the first is still `modifying` would itself
error. `create()` should therefore check for an existing in-flight
modification first (via `DescribeVolumesModifications`) and, if one is
already targeting the same size, skip straight to polling it rather than
issuing a redundant `ModifyVolume`.

**Determinism** — Single volume, single target size; the optional SSM
sub-step, if configured, always runs after AWS-side completion is
confirmed, never interleaved.

**Ordering** — Depends on the volume (and, if using the optional SSM path,
the instance) already existing — precondition. No dependency on other
tasks in this list for the core AWS-side resize.

**verify()** — `DescribeVolumes` confirms `Size == target`. If the optional
SSM sub-step was configured and ran, verify also confirms the SSM command
reported success; if the sub-step was not configured, verify does **not**
attempt to confirm in-OS filesystem size (would require guest-OS
introspection this integration doesn't otherwise have), and the report
explicitly states filesystem growth was not verified/performed.

**Configurable params** — volume id, target size (GiB), optional
`volumeType`/`iops`/`throughput`, optional `ssmDocumentName` + owning
instance id to opt into the in-OS grow sub-step.

**Step decomposition** — One step for the AWS-side resize; the optional
in-OS grow is a sub-step *within* that same step's `create()` (gated by
whether SSM params are supplied), not a separate top-level step — because
it's genuinely optional and conditionally-skipped, unlike, say,
`create-bucket`'s always-composed multi-factory steps. `resource()` reports
`{ type: "aws_ebs_volume", attributes: { volumeId, size, osResizePerformed
} }`.

### Sanity check

This is the task the prompt specifically asked to get right, and the
AWS-side/in-OS boundary is confirmed directly from `ModifyVolume`'s own
docs page, which explicitly says post-resize filesystem extension is a
separate, subsequent action the caller must perform — this is not an
inference, it's the literal documented flow. The `optimizing`-is-usable
detail is also directly from the docs' own example response
(`modificationState: optimizing`, `progress: 40`, clearly mid-flight but
attached and in-use). The one soft spot: whether `"optimizing"` alone
(vs. waiting for `"completed"`) is the right gate before declaring the
AWS-side step done is a judgment call — this plan picks `"optimizing"` as
sufficient because the volume is already fully usable at that state and
waiting for `"completed"` could add a long, unnecessary wait for large
volumes; a more conservative build could require full `"completed"`
instead, and that's a legitimate alternative worth a one-line decision note
in the README when built.

---

## 9. create-ami-from-instance

**check()** — Same identity-tag approach as `create-ebs-snapshot`: no
natural "does this AMI already exist" check by name/content, so tag the
AMI at creation with `ferry:integration-id` + a caller-supplied logical
name, and `check()` does `DescribeImages` (owned by self, filtered by that
tag) for a match in `pending` or `available` state. Match → `"exists"`. No
match → `"missing"`.

**reconcile()** — N/A; create-only (baking a new AMI from a changed
instance is a new logical AMI, not a reconcile of an old one — AMIs are
immutable once `available`).

**create()** —
1. `CreateImage` with `InstanceId`, `Name`, `Description`, and the
   `NoReboot` param (**configurable, not hardcoded** — default `false` per
   the docs, which triggers a reboot "to ensure that all buffered data and
   data in memory is written to the volumes before the snapshots are
   created," i.e. crash-consistency vs. full consistency; `NoReboot=true`
   skips the reboot and produces snapshots that only capture "data that has
   been written to the volumes at the time the snapshots are created" —
   the docs' own wording for the risk, surfaced directly in this
   integration's param documentation and README rather than summarized
   away). Also pass a `TagSpecification` for `ResourceType=image` (and
   optionally `snapshot`) carrying the identity tag.
2. `pollUntil` via `DescribeImages` until `State == "available"` (verified
   async: `pending → available`, with the underlying EBS snapshots
   following the same lifecycle as task 7). A `State == "failed"` (or a
   populated `StateReason`) during the poll is an immediate failure, not a
   continued wait.
3. Capture `imageId` and the snapshot ids backing it (from `BlockDeviceMap
   pings` in the `DescribeImages` response) into `ctx.outputs` — the
   snapshots are needed for rollback, since deregistering an AMI does
   **not** automatically delete its backing snapshots.

**rollback()** — `DeregisterImage` on the captured `imageId`, then
`DeleteSnapshot` on each backing snapshot id captured above — both are
this run's own creations, so cleaning up both is correct and complete (no
best-effort caveat needed here, unlike `terminate-instance`).

**Idempotency** — Tag-based lookup in `check()` gives Ferry-level
idempotency (`CreateImage` itself is not on the client-token or
idempotent-by-default lists) — a re-run after an interrupted first attempt
finds the tagged, still-`pending`-or-now-`available` image and skips
straight to `"exists"` rather than baking a second AMI.

**Determinism** — Single instance, single resulting AMI per run.

**Ordering** — Depends on the source instance already existing
(precondition from `launch-instance` or pre-existing). If `NoReboot=false`
(the default), this operation reboots the source instance as a side
effect — a real, documented interaction worth calling out prominently in
the README (not a "conflict" with any other task in this list, but a
behavior change to the live instance that a caller invoking this
integration should expect).

**verify()** — `DescribeImages` confirms `State == "available"` and that
the image's `BlockDeviceMappings` reference the captured snapshot ids.

**Configurable params** — instance id, AMI name, description, `NoReboot:
boolean` (default `false`, matching the API default — exposed, not
hidden, exactly per the task's requirement), tags.

**Step decomposition** — One step. `resource()` reports
`{ type: "aws_ami", attributes: { imageId, sourceInstanceId, noReboot } }`.

### Sanity check

`CreateImage`'s `NoReboot` default (`false`) and its documented consistency
tradeoff are both direct quotes from the fetched docs — no ambiguity here.
The `pending → available` async lifecycle, and the fact that deregistering
an AMI leaves its snapshots behind unless explicitly deleted, are both
correctly reflected in the rollback design; this is one of the cleaner
tasks in this plan with no structural open questions.

---

## 10. assign-elastic-ip

**check()** — Two independent pieces of state to check jointly:
allocation and association. `DescribeAddresses` filtered by a
`ferry:integration-id` tag (applied at allocation) to find "does this run's
EIP already exist." No tagged address → `"missing"` (need to allocate).
Tagged address exists but `AssociationId` is empty/unset → `"missing"`
still, from the association's point of view — treat this integration as
one combined step covering both allocate-and-associate, so partial
progress (allocated, not yet associated) is still `"missing"` overall.
Tagged address already associated with the target `instanceId` → `"exists"`.
Tagged address associated with a **different** instance → `"conflict"`
(mirrors `attach-detach-ebs-volume`'s refusal to silently re-point
something already pointed elsewhere — even though `AssociateAddress` is
happy to silently move it, per its own docs, this integration should not
do that without the plan phase surfacing it first).

**reconcile()** — N/A; create-or-skip, same reasoning as task 4/6.

**create()** —
1. `AllocateAddress` (`Domain=vpc`) with a `TagSpecification` carrying the
   identity tag. Capture `allocationId`, `publicIp`.
2. `AssociateAddress` with `AllocationId` and `InstanceId`. Verified:
   `AssociateAddress` is idempotent by default (EC2 idempotency page) and
   explicitly documented as safe to call repeatedly against the same
   instance ("This is an idempotent operation... you may be charged for
   each time... remapped to the same instance" — a cost note, not a
   correctness one). Pass `AllowReassociation=false` explicitly rather
   than relying on the default (auto-reassociate) — this integration wants
   a hard failure if the target instance already has a *different* EIP or
   this address is attached elsewhere, consistent with the `"conflict"`
   stance in `check()`, rather than the API's default "just move it"
   behavior.
3. Capture `associationId` in `ctx.outputs`.

**rollback()** — `DisassociateAddress` (verified idempotent by default)
using the captured `associationId`, then `ReleaseAddress` on the captured
`allocationId`. Both are this run's own creations, so full, precise
rollback — no best-effort caveat needed.

**Idempotency** — `AssociateAddress`'s own documented idempotency plus the
tag-based `check()` lookup double up here: even without the tag, re-
running `AssociateAddress` against the same instance is safe per AWS's own
docs; the tag lookup additionally avoids allocating a **second**, redundant
EIP if `AllocateAddress` succeeded but the process died before association
completed (`AllocateAddress` has no idempotency token, so without the tag
lookup a naive retry would leak an unused Elastic IP — Elastic IPs are
billed when unassociated, so this leak has a real cost, not just an API
correctness issue).

**Determinism** — Single instance, single resulting EIP per run.

**Ordering** — Depends on the instance already existing (precondition).

**verify()** — `DescribeAddresses` confirms the tagged address's
`InstanceId`/`AssociationId` matches the target instance.

**Configurable params** — instance id, tags. (No CIDR/pool params — this
plan only covers "allocate a new EIP and associate it," not "associate an
existing pre-allocated EIP," which would be a different, simpler
integration.)

**Step decomposition** — One step covering both allocate and associate —
they're inseparable at the identity level here (an allocated-but-
unassociated EIP from this integration has no purpose on its own), unlike
`create-bucket`'s multi-factory composition of genuinely independent
settings. `resource()` reports `{ type: "aws_eip", attributes:
{ allocationId, publicIp, instanceId } }`.

### Sanity check

`AssociateAddress`'s idempotent-by-default status and its explicit
"existing address is disassociated... but remains allocated" behavior are
both directly quoted from the fetched docs — the choice to pass
`AllowReassociation=false` and treat "already attached elsewhere" as
`"conflict"` rather than silently accepting the API's default move-it
behavior is a deliberate safety stance, flagged here as a design decision
(not an AWS constraint) in case a reviewer wants the more permissive
default instead.

---

## 11. tag-instance

**check()** — Always-reconcile, self-idempotent — the closest analogue in
this plan to `s3VersioningStep`'s "whole-document-replace API" pattern,
since `CreateTags`/`DeleteTags` collectively let this step PUT the desired
tag set directly rather than diffing add/remove the way security-group
rules require (there's no "exactly one of three fields" per-tag
constraint the way there is for SG rules — a tag is just a key/value pair,
freely overwritable). `check()` reads current tags via `DescribeTags`
(filtered to this `resourceId`) and reports `"exists"` whenever the
instance itself exists (regardless of current tag content — the diff is
reconcile's job); `"conflict"` only if the instance itself doesn't exist
(nothing to tag) — reported as `"conflict"` rather than `"missing"` since
this integration never creates an instance.

**reconcile()** —
1. Read current tags via `DescribeTags`.
2. Diff current vs. desired (from params): keys in desired not present (or
   present with a different value) → apply via `CreateTags` (which both
   adds new tags and overwrites existing ones sharing a key — confirmed
   standard `CreateTags` behavior); keys present live but absent from
   desired, **only if** a `pruneUnmanagedTags: boolean` param is explicitly
   true → remove via `DeleteTags`. Default `false` — i.e. by default this
   step only ever adds/updates tags it's told about and never removes a
   tag some other process or person set, mirroring the general "don't
   silently undo things this run didn't do" instinct, and specifically
   avoiding accidentally erasing AWS-managed or other-tooling tags (e.g.
   `aws:` reserved prefixes, or a Terraform-managed tag) that happen not to
   be listed in this run's params.
3. Capture the pre-reconcile values of every key this run touched (added,
   changed, or removed) in `ctx.outputs`, so rollback can restore exactly
   the previous tag state — same discipline the Step contract's own
   documentation calls out for reconcile steps ("must capture the prior
   value in its outputs so that rollback() can put it back").

**rollback()** — For each key this run added: `DeleteTags` that key. For
each key this run changed: `CreateTags` with the captured prior value. For
each key this run removed (only relevant if `pruneUnmanagedTags=true`):
`CreateTags` restoring the captured prior value. Fully precise, since every
touched value was captured.

**Idempotency** — Diffing against a fresh live read each run makes this
naturally idempotent — a re-run with the same desired tag set is a no-op
diff (nothing to apply), exactly the "always-reconcile, self-idempotent"
property `s3VersioningStep` established for whole-document-replace APIs,
adapted here to a key/value diff since tags aren't literally a single
document PUT.

**Determinism** — The diff is computed once from a single live read per
run; tag application order doesn't matter (each key is independent).

**Ordering** — Depends on the instance already existing — real
precondition from `launch-instance` or any pre-existing instance.

**verify()** — Live `DescribeTags` matches the desired tag set (plus,
if `pruneUnmanagedTags=false`, superset — any pre-existing tags not
mentioned in params are still present, confirming they weren't
accidentally dropped).

**Configurable params** — instance id, desired tag key/value map,
`pruneUnmanagedTags: boolean` (default `false`).

**Step decomposition** — One step over the whole tag map, not one
step-factory instance per tag key — same reasoning as
`update-security-group-rules`: tags are a single mutable collection
attached to one resource, not N independently-identified resources.
`resource()` reports `{ type: "aws_ec2_instance_tags", attributes:
{ instanceId, tagCount } }`.

### Sanity check

`CreateTags`'s overwrite-on-existing-key behavior is standard, well-
documented EC2 behavior and wasn't re-fetched in this pass since it's not
one of the contentious/ambiguous APIs the task called out for deep
verification — flagging that as a lower-confidence spot relative to the
others in this document, though the behavior is uncontroversial enough
(same semantics across virtually all AWS resource-tagging APIs) that it's
unlikely to be wrong. The `pruneUnmanagedTags` default-`false` choice is a
deliberate safety stance worth confirming with whoever builds this: an
alternative, stricter design would make tag state fully declarative
(desired set == live set, always pruning) the way `s3VersioningStep`-style
steps are for a true single-value setting — tags are just less clearly
"owned entirely by one integration" in practice, since many tools tag the
same instance for different purposes.

---

## 12. update-instance-type

**check()** — `DescribeInstances` on `instanceId`. Current `InstanceType`
already equals the target → `"exists"`. Differs → `"missing"`. Current
state is a mid-transition state (`pending`/`stopping`/`shutting-down`) →
`"conflict"` (don't start this orchestration against an instance that's
already mid-transition for an unrelated reason). `terminated` →
`"conflict"` (nothing to resize).

**reconcile()** — N/A; this is a create-or-skip toggle against the target
type, not an always-reconcile step.

**create()** — The stop → modify → start orchestration the task asks for,
built by composing `stop-start-instance`'s own stop/start logic as a
shared helper (see the ordering note below for whether that's duplication
or reuse — this plan resolves it as **intentional shared-helper reuse**,
not duplication: the same `StopInstances`/`pollUntil("stopped")` and
`StartInstances`/`pollUntil("running")` logic is factored into a shared
provider-level helper function, analogous to how `s3.ts` factors
`listKeys`/`deleteKeys`/`copyObject` for reuse across multiple S3
integrations rather than each integration reimplementing them):
1. Capture the current `InstanceType` in `ctx.outputs` (needed for
   rollback).
2. If not already `stopped`: call the shared stop helper — `StopInstances`
   + `pollUntil` until `State.Name == "stopped"` (verified: instances can
   have certain attributes, including instance type, modified "while your
   instance is in the `stopped` state").
3. `ModifyInstanceAttribute` with `Attribute=instanceType`,
   `Value=<target type>`. Verified as a hard, unconditional requirement
   from the docs' own worked example: "This example changes the
   `instanceType` attribute of the specified instance. The instance must
   be in the `stopped` state" — not a soft recommendation.
4. Call the shared start helper — `StartInstances` + `pollUntil` until
   `State.Name == "running"`.
5. Capture the new `InstanceType` (confirmed via a final
   `DescribeInstances` read) in `ctx.outputs`.

**rollback()** — This is the task's flagged risk area, addressed directly
rather than glossed over:
- If rollback is invoked **before** step 3 (`ModifyInstanceAttribute`) ran
  — e.g. the stop succeeded but the process died before modifying the
  type — the captured "original type" is still the live type, so rollback
  is simply: ensure the instance ends up back in its pre-run running/
  stopped state (if it was originally `running`, start it back up; ID
  document this as **not guaranteed lossless** only in the sense that "was
  it running before" is what's restored, not literally every in-memory
  detail — data on the EBS root/attached volumes is untouched either way,
  since stop/start never touches volume contents per the lifecycle page).
- If rollback is invoked **after** step 3 succeeded but step 4 (start)
  fails or is interrupted — the instance is now `stopped`, with the *new*
  type already applied. Rollback here is: `ModifyInstanceAttribute` back to
  the captured original type (this call itself has no special
  precondition beyond "stopped," which the instance already is at this
  point — so reverting the type is safe and identical in shape to the
  forward change), then attempt `StartInstances` to restore the pre-run
  running state.
- **The genuine, un-resolvable risk**, stated plainly rather than
  asserted away: if the **original** instance type is no longer available
  in that Availability Zone at rollback time (capacity exhausted, or the
  AZ has stopped offering that type — both real, documented EC2
  possibences, not hypothetical), `StartInstances` after reverting the
  type can itself fail, leaving the instance `stopped` with the type
  successfully reverted but not running. This plan's stance: rollback
  should not loop indefinitely retrying `StartInstances` against a
  capacity error — `retryWithBackoff` with a bounded retry count (its
  `retryable()` predicate should treat AWS's capacity/availability errors,
  e.g. `InsufficientInstanceCapacity`, as retryable, but throw immediately
  on anything else) is the right tool here, but a bounded number of
  retries is still not a guarantee. If exhausted, rollback should surface
  a loud, explicit failure state — "instance type was reverted to
  <original>, but the instance could not be restarted; manual intervention
  required" — rather than silently reporting a clean rollback. This is
  the honest answer to the task's own question ("is full rollback... always
  possible") — no, it is not always possible, and this plan does not
  pretend otherwise.

**Idempotency** — `check()`'s type comparison makes a re-run against an
already-resized (and running) instance a clean skip. A re-run after a
partial failure mid-orchestration re-observes the actual live state
(current type + current power state) and resumes from wherever it actually
is, rather than blindly replaying all three steps.

**Determinism** — Single instance, single target type, strictly ordered
stop → modify → start (this ordering is not negotiable — it's the AWS
constraint itself, not a Ferry design choice).

**Ordering** — This task's stop/start logic is a **real, intentional
duplication-vs-reuse question**, resolved above as shared-helper reuse:
the underlying `StopInstances`/`StartInstances`/poll logic is factored
into one shared helper used by both `stop-start-instance` (task 3) and
this task, rather than two independent copies (per this project's own
"two bespoke copies are fine, a third gets promoted" rule already applied
once to `retryWithBackoff` itself — the same principle applies here: don't
wait for a third copy to appear before sharing something this exactly
duplicated). `update-instance-type` does **not** literally invoke
`stop-start-instance` as an integration (that would mean running a whole
separate plan/apply/verify cycle mid-step, which the Step contract doesn't
support) — it calls the same underlying provider-level function each
integration's steps call into.

**verify()** — `DescribeInstances` confirms `InstanceType == target` and
`State.Name == "running"`.

**Configurable params** — instance id, target instance type.

**Step decomposition** — One step, orchestrating three ordered API calls
against a single instance — not three separate steps, since the whole
sequence is one atomic-in-intent operation with one combined rollback
story (a partial "stopped but not modified" or "modified but not
restarted" state isn't a separately useful checkpoint the way, say,
`create-bucket`'s separately-toggleable versioning/encryption steps are).
`resource()` reports `{ type: "aws_ec2_instance", attributes:
{ instanceId, instanceType } }`.

### Sanity check

The hard "must be stopped" requirement for changing `instanceType` is
directly confirmed by `ModifyInstanceAttribute`'s own worked example text
("The instance must be in the `stopped` state") — not inferred. The
rollback risk section is the most important part of this task per the
original brief, and this plan is deliberately not asserting rollback is
always safe: instance-type availability in a given AZ is a real, external
constraint EC2 does not guarantee, so "revert type, try to restart" can
genuinely fail, and the plan calls for a loud failure state instead of a
false "rolled back successfully" claim. This mirrors this project's
existing honesty about `delete-empty-bucket`'s best-effort rollback — the
same discipline, applied to a case where the failure mode is a stuck
`stopped` instance rather than lost bucket configuration.
