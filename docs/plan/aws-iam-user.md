# aws/iam/user — Implementation Plan

> Grounded against Ferry's step contract (`src/core/define.ts`), engine semantics
> (`src/core/engine.ts`), the `retryWithBackoff`/`pollUntil` helpers
> (`src/core/wait.ts`), the shared AWS provider helpers (`src/providers/aws/iam.ts`,
> `s3.ts`), and the closest existing precedent,
> `integrations/aws/s3/create-backend-s3-user` (IAM user + policy + access key,
> propagation-retry verify). Every API-level claim below (required params,
> quotas, idempotency, preconditions) was checked against
> `docs.aws.amazon.com/IAM/latest/APIReference` and the IAM User Guide during
> drafting, and re-checked in the sanity-check pass at the end of each section.
>
> No code below — English-language algorithm steps only, in Ferry's own
> `check()`/`create()`/`reconcile()`/`rollback()`/`verify()` vocabulary.

## Shared groundwork

A few facts recur across nearly every task and are stated once here rather
than repeated twelve times:

- **IAM presence has no third state.** Unlike S3 bucket names, IAM entity
  names (`UserName`, `GroupName`, `PolicyArn`) are account-scoped, not
  globally unique. `src/providers/aws/iam.ts`'s `userState`/`policyState`/
  `roleState` helpers already encode this: `NoSuchEntityException` →
  `"missing"`, anything else → `"exists"` or a real error. There is no S3-style
  403-means-somebody-else's-bucket case for a user, policy, or group — so
  `check()` in every task below is a two-way presence probe, not three-way,
  unless stated otherwise.
- **`DeleteUser` will not cascade.** Per AWS's own docs: *"Unlike the AWS
  Management Console, when you delete a user programmatically, you must
  delete the items attached to the user manually, or the deletion fails."*
  The documented list to clear first is: login profile (password),
  access keys, signing certificate, SSH public key, git credentials
  (service-specific credentials), MFA device(s) (deactivate + delete virtual
  device), inline policies, attached managed policies, and group memberships.
  A `DeleteUser` call against a user still holding any of these returns
  `DeleteConflict` (409), naming the offending entity in the message. This is
  why `delete-user` and `offboard-user` are necessarily multi-step teardown
  sequences, not a single API call.
- **Access keys are hard-capped at 2 per user.** `CreateAccessKey` beyond
  that returns `LimitExceeded` — AWS's own message reads "Cannot exceed quota
  for AccessKeysPerUser: 2". This is not configurable and not raisable via a
  quota increase request; it shapes `create-access-key`'s and
  `rotate-access-key`'s `check()` semantics directly.
- **There is no "require MFA" attribute on a user.** MFA enforcement is a
  *policy* mechanism: a condition key (`aws:MultiFactorAuthPresent`, and
  optionally `aws:MultiFactorAuthAge`) inside an IAM policy's `Condition`
  block, evaluated against session context that is only present when the
  caller obtained temporary credentials via `GetSessionToken` or `AssumeRole`
  with an MFA code. Long-term IAM user access keys never carry this context,
  so an access-key-based caller can never satisfy an MFA condition — the
  condition simply denies them. Registering a device (`CreateVirtualMFADevice`
  + `EnableMFADevice`, or a hardware/U2F device) and attaching an
  MFA-conditioned policy are two independent, composable actions; neither
  alone "enforces" anything.
- **IAM writes are eventually consistent.** A freshly created user, freshly
  attached policy, or freshly minted key can read back as absent or as
  "denied" for several seconds after the call that created it returns
  success. Every step below that reads its own write back (for `check()` on
  a re-run, or for `verify()`) should ride out that window with
  `retryWithBackoff` (already promoted into `src/core/wait.ts` for exactly
  this reason, first used in create-backend-s3-user's `verify.ts`) or
  `pollUntil` where a boolean "is it visible yet" predicate is more natural
  than a retry-attempt shape.
- **A `genericIamUserPolicyAttachStep` factory is worth extracting.** The
  existing `create-backend-s3-user/steps/attach-policy.ts` step is already a
  clean, reusable shape (list attached policies → check membership → attach
  if missing → detach only if this run attached it). Tasks 3 and 4 below
  should promote it to `src/providers/aws/iam.ts` (parameterized by user,
  policy ARN, and direction) rather than each hand-rolling a copy — this
  mirrors how `retryWithBackoff` itself was promoted "on the third occurrence
  of this exact shape."

---

## 1. create-user

**check()** — `userState(iam, userName)`. `"exists"` if `GetUser` succeeds,
`"missing"` on `NoSuchEntityException`. No conflict state: IAM user names are
account-scoped, so there is no "exists but owned by someone else" case the way
S3 buckets have.

**reconcile()** — N/A for the base user object; this step declares only
`create()`.

1. `CreateUserCommand({ UserName })`. Optionally accepts a `Path` and initial
   `Tags` in the same call (`CreateUser` accepts a `Tags` array directly,
   avoiding a separate `TagUser` call when tags are known up front) and a
   permissions boundary ARN (`PermissionsBoundary`) if the integration's
   params include one — worth exposing as an optional param since it is the
   single cheapest guardrail against over-broad follow-on policy attachments.
2. Record `userArn`, `userCreatedThisRun: true` in outputs.

**rollback()** — `DeleteUserCommand`. Safe only because this step's rollback
is only ever registered when `create()` ran (per the engine's own rule:
"registered only now… rolling back something that already existed is the one
thing this tool must never do"). If a later step in the same run attached a
policy or minted a key, LIFO ordering means those steps' rollbacks (detach,
delete key) run *before* this one, so by the time `DeleteUser` runs here the
user is already bare — no `DeleteConflict` expected in the normal rollback
path.

**Idempotency** — re-run against an already-created user: `check()` returns
`"exists"`, `create()` is skipped, nothing changes. Matches the
"exists → skip" idiom used throughout `create-backend-s3-user`.

**Determinism** — none; a single named resource, single API call.

**Ordering** — root/first step of any chain that provisions a user identity
(this task, task 5's key, task 3's policy attachment, task 9's group
membership all depend on the user existing). No cross-task cycle.

**verify()** — `GetUserCommand` succeeds and returns the same `UserName`
(guards against a race where a concurrent process deleted it between apply
and verify). If `Path`/tags/boundary were requested, confirm they read back.

**Configurable params** — `IAM_USER_NAME` (required), optional `IAM_USER_PATH`,
optional `IAM_PERMISSIONS_BOUNDARY_ARN`, optional initial tags (reuse task
11's tag shape).

**Step decomposition** — one step, one named resource
(`resource()` → `{ type: "aws_iam_user", attributes: { arn } }`), same shape
as the existing `iamUserStep` in create-backend-s3-user (in fact this task's
step *is* that existing step, generalized to stand alone rather than being
folded into one integration's `steps` array — it should move to
`src/providers/aws/iam.ts` as a shared factory, parameterized on username/
path/boundary, the same way `s3BucketStep` lives in the shared s3 module
rather than inside `create-bucket`'s own folder).

**Sanity check** — Matches `CreateUser`/`DeleteUser`/`GetUser` API docs
exactly: no required params beyond `UserName`, `Path` and `PermissionsBoundary`
optional, `Tags` acceptable inline. No structural concerns; this is the
simplest task in the set and is already proven out almost verbatim by
`create-backend-s3-user/steps/iam-user.ts`.

---

## 2. delete-user

**check()** — `userState(iam, userName)`. `"missing"` → nothing to do (the
"inverted create-or-skip" pattern for deletes: `"missing"` here means
*already deleted*, so this step should declare no `create()` and instead only
ever run through a delete-shaped `reconcile()`/dedicated delete path — see
step decomposition below for how Ferry's `Step<P>` contract, which is
oriented around creating things, is bent to express a destructive op).
`"exists"` → proceed.

**reconcile()** — this integration is fundamentally a teardown, so rather than
one step with a `create()` that never runs, it is modeled as an ordered
sequence of small steps, each independently idempotent, culminating in
`DeleteUser`:

1. `ListAccessKeysCommand` → `UpdateAccessKeyCommand(Inactive)` optional, then
   `DeleteAccessKeyCommand` for each key returned (0, 1, or 2 keys).
2. `GetLoginProfileCommand` (404 if none) → `DeleteLoginProfileCommand` if
   present.
3. `ListMFADevicesCommand` → for each device, `DeactivateMFADeviceCommand`
   then, if it is a virtual device (ARN pattern `.../mfa/...`),
   `DeleteVirtualMFADeviceCommand`.
4. `ListGroupsForUserCommand` → `RemoveUserFromGroupCommand` per group.
5. `ListAttachedUserPoliciesCommand` → `DetachUserPolicyCommand` per policy.
6. `ListUserPoliciesCommand` (inline policies) → `DeleteUserPolicyCommand` per
   policy name.
7. Only once 1–6 all report empty: `DeleteUserCommand`.

**rollback()** — **deliberately does not attempt to recreate what was
deleted.** A deleted access key's secret is gone forever (AWS never returns
it again — `CreateAccessKey`'s own docs: "the secret access key is accessible
only during key and user creation"), and a deleted login profile's password
is unrecoverable. Rollback here can only recreate the *user* (bare,
no policies/keys/groups) with a loud warning that everything torn down in
steps 1–6 is unrecoverable — this is the honest analogue of the versioning
step's "cannot be restored to never-configured" rollback caveat in
`s3VersioningStep`. Practically: this step's `rollback()` should refuse to
silently pretend to restore prior state, and instead recreate the bare user
and log every artifact that could not be restored (count of keys deleted,
whether a login profile existed, whether MFA was configured, which groups/
policies it held) using values captured into `ctx.outputs` *before* each
delete call in steps 1–6.

**Idempotency** — interrupted mid-teardown → re-run re-lists whatever
category failed to empty and resumes; every delete call in 1–6 is itself
idempotent against a resource already gone (`NoSuchEntityException` treated
as success, not error, exactly like `attach-policy.ts`'s rollback already
does for `DetachUserPolicy`).

**Determinism** — the *order* of 1–6 does not matter to AWS (there's no
inter-dependency among detach/remove/delete-key calls), but all of 1–6 must
complete before 7 — `DeleteUser` hard-gates on it (`DeleteConflict`
otherwise). This mirrors delete-bucket-with-transfer's
"copy-all → verify-all → delete-source" hard invariant.

**Ordering** — no dependency on any other task in the *forward* direction,
but shares essentially all of its teardown logic with task 12
(`offboard-user`). This is the doc's central duplication question, addressed
below.

**verify()** — `GetUserCommand` now throws `NoSuchEntityException`
(confirms deletion). If rollback path was exercised instead, `GetUserCommand`
succeeds and returns zero keys/groups/policies.

**Configurable params** — `IAM_USER_NAME`; optional
`ALLOW_DESTRUCTIVE_TEARDOWN` boolean gate (a human confirmation flag, following
the project's convention of hard-gating irreversible ops rather than a bare
`--force`), since this permanently destroys credentials with no recovery path.

**Step decomposition — reuse question.** `delete-user` and `offboard-user`
(task 12) do the identical detach/remove/deactivate/delete sequence; the only
difference the prompt's own task list draws is that `offboard-user` frames it
as an HR/access-lifecycle action ("full teardown") while `delete-user` is the
generic IAM primitive. **This should be one shared internal helper — a
`iamUserTeardownSteps(userName)` factory in `src/providers/aws/iam.ts`
returning the same ordered step array — consumed by *both* integrations’
`steps: [...]`, rather than two integrations each re-implementing six API
calls.** `offboard-user`'s only addition on top is possibly emitting a richer
report (departure paperwork trail) — not additional API surface. Treating them
as one shared helper avoids the "two bespoke copies is fine, a third gets
promoted" drift the project already flags for `retryWithBackoff`; here there'd
only be two copies, but they are copies of a *destructive, security-sensitive*
sequence, which raises the bar for deduplication even at N=2.

**Sanity check** — Confirmed against `DeleteUser`'s own doc, which
enumerates exactly this list (password, access keys, signing cert, SSH key,
git credentials, MFA device, inline policies, attached policies, groups) and
states `DeleteConflict` (409) is the failure mode if anything remains. Two
items the prompt's task didn't call out explicitly but the docs do:
signing certificates and SSH public keys and git (CodeCommit)
credentials — genuinely rare for a machine/backend user, but a fully honest
`delete-user` should still list-and-clear them (`ListSigningCertificatesCommand`,
`ListSSHPublicKeysCommand`, `ListServiceSpecificCredentialsCommand`) or the
delete will 409 on an account that happens to have them. Flagging this as a
real gap versus the prompt's enumerated list, not an invented one.

---

## 3. attach-policy-to-user

**check()** — `ListAttachedUserPoliciesCommand({ UserName })`, test whether
the target `PolicyArn` is present. `"missing"` if not attached (including if
the user itself doesn't exist yet — `NoSuchEntityException` folds to
`"missing"`, matching `attach-policy.ts`'s existing comment: "The user itself
doesn't exist yet — an earlier step will create it").

**create()** —
1. `AttachUserPolicyCommand({ UserName, PolicyArn })`. Note: `AttachUserPolicy`
   itself is naturally idempotent at the API level (attaching an already-attached
   policy is a harmless no-op), but Ferry's own `check()` must still
   distinguish "we attached this" from "it was already there" — otherwise
   rollback would detach an attachment this run did not create, which is
   exactly the failure mode `attach-policy.ts`'s own comment warns against.
2. Record `policyAttachedThisRun: true`.

**rollback()** — `DetachUserPolicyCommand`, tolerant of
`NoSuchEntityException` (user or attachment already gone).

**Idempotency** — re-run against an already-attached policy: `check()` →
`"exists"`, skip.

**Determinism** — none; single attach call.

**Ordering** — depends on both the user (task 1) and the policy already
existing (this task does not create the policy — same "operates on an
existing entity, doesn't create one" pattern as `s3BucketExistsGuardStep`; a
missing policy ARN should fold to `"conflict"`, not silently proceed, exactly
per that guard step's own rationale: "without this, a missing bucket would
silently plan a skip and the real failure would only surface... instead of
aborting cleanly in the plan phase").

**verify()** — `ListAttachedUserPoliciesCommand` (with `retryWithBackoff` for
propagation) confirms the ARN is present.

**Configurable params** — `IAM_USER_NAME`, `IAM_POLICY_ARN` (a full ARN, not
just a name — supports both customer-managed and AWS-managed policies, e.g.
`arn:aws:iam::aws:policy/ReadOnlyAccess`, without requiring an account-id
lookup for AWS-managed ones).

**Step decomposition** — this is exactly `create-backend-s3-user`'s existing
`attachPolicyStep`, generalized. Promote it to
`genericIamUserPolicyAttachStep({ userName, policyArn })` in
`src/providers/aws/iam.ts`; both this task and task 4 (in inverse) and task 2/
12's teardown sequences become callers rather than each re-deriving the same
`List/Attach/Detach` triad.

**Sanity check** — Matches `AttachUserPolicy`/`ListAttachedUserPolicies` docs:
no surprising constraints beyond the account-wide "10 managed policies per
user" default quota (raisable to 20), worth a `check()`-time warning if the
user is already near it, though not a hard gate ferry needs to enforce itself
(AWS will reject it with `LimitExceeded` and the run aborts normally).

---

## 4. detach-policy-from-user

**check()** — inverted from task 3: `ListAttachedUserPoliciesCommand`, is the
ARN present? `"exists"` (present, meaning there's a detach to do) vs.
`"missing"` (already absent — nothing to do). This is the same
"inverted create-or-skip" framing the prompt names for deletes: the step's
"actionable" state is `"exists"`, not `"missing"`, so this step declares no
`create()` — only `reconcile()` runs, and it runs precisely when the
attachment is still there.

**reconcile()** —
1. `DetachUserPolicyCommand({ UserName, PolicyArn })`.
2. Capture that this run performed the detach (for rollback) and, since
   detaching necessarily means *some* policy document was previously
   in effect, no need to snapshot a "prior policy" the way
   `s3BucketPolicyStep` does for a whole-document-replace API — attach/detach
   are additive/subtractive on a *set* of ARNs, not a document replace, so
   the prior state is fully described by "it was attached; now it isn't."

**rollback()** — `AttachUserPolicyCommand` to restore it. Safe re-attach: this
step only ever ran (and thus only ever registers a rollback) when the
attachment existed and this run removed it.

**Idempotency** — re-run when already detached: `check()` → `"missing"`,
skip.

**Determinism** — none.

**Ordering** — same precondition as task 3 (user and policy both already
exist; use the same existence-guard idiom, folding a missing user or policy
to `"conflict"` rather than treating "nothing to detach" and "can't reach the
entity to check" as the same thing).

**verify()** — `ListAttachedUserPoliciesCommand` confirms the ARN is now
absent.

**Configurable params** — `IAM_USER_NAME`, `IAM_POLICY_ARN`.

**Step decomposition** — the inverse call of the same
`genericIamUserPolicyAttachStep` factory proposed in task 3 — same factory,
`direction: "attach" | "detach"` — rather than a hand-rolled twin.

**Sanity check** — No surprises versus `DetachUserPolicy` docs. One real
question: if the user holds *no* attached policies at all when this runs,
`ListAttachedUserPolicies` simply returns an empty list (not an error), so
`"missing"`/skip is correct and requires no special-casing.

---

## 5. create-access-key

**check()** — `ListAccessKeysCommand({ UserName })`.
- 0 keys → `"missing"`.
- 1 key → `"exists"` **but this is the ambiguous case the prompt calls out**:
  a caller might mean "ensure at least one key exists" (skip, matches
  create-backend-s3-user's existing `accessKeyStep` behavior exactly — "a
  user that already holds a key is left alone... rotation is a deliberate
  act") or "I explicitly want a *second* key for a rotation window" (should
  proceed to `create()`). Because `check()` cannot know the caller's intent
  from state alone, this needs a param, not an inference:
  `ALLOW_SECOND_KEY` (default false). With it false (the default,
  matching existing behavior), 1 key → `"exists"`/skip. With it true, 1 key →
  `"missing"`/proceed (this is what `rotate-access-key`, task 6, sets
  internally when it calls into this same step).
- 2 keys → always `"exists"`/skip, unconditionally — `create()` would 409
  with `LimitExceeded` regardless of any flag, so `check()` must report
  `"exists"` (not attempt and fail) to keep the plan phase honest per the
  engine's own contract of "every check() runs before any create() does."

**create()** —
1. `CreateAccessKeyCommand({ UserName })`.
2. Return `{ accessKeyId, secretAccessKey, accessKeyCreatedThisRun: true }` —
   secret held only in `ctx.outputs` in memory, never written to disk, printed
   to stdout exactly once at report time, matching create-backend-s3-user's
   existing pattern verbatim (`console.log` block in `report()`, masked value
   in the persisted markdown).

**rollback()** — `DeleteAccessKeyCommand`, tolerant of
`NoSuchEntityException`.

**Idempotency** — re-run with `ALLOW_SECOND_KEY=false` and a key already
present: skip, no new key minted (this is the existing, load-bearing
behavior the create-backend-s3-user README calls out: "a re-run mints no
second key... creating a key on every run would burn through the two-key AWS
limit").

**Determinism** — none.

**Ordering** — depends on the user existing (task 1).

**verify()** — `retryWithBackoff` around a cheap authenticated call using the
new key (e.g. `sts:GetCallerIdentity` with the new credentials) to confirm
it is live, mirroring create-backend-s3-user's `withPropagationRetry` for
`InvalidAccessKeyId`/`SignatureDoesNotMatch` during the propagation window.

**Configurable params** — `IAM_USER_NAME`, `ALLOW_SECOND_KEY` (bool, default
false).

**Step decomposition** — one step, one resource
(`{ type: "aws_iam_access_key", attributes: { accessKeyId } }`), directly
reusing create-backend-s3-user's existing `accessKeyStep` shape as a shared
factory parameterized by username and the new `ALLOW_SECOND_KEY` flag.

**Sanity check** — Confirmed the 2-key hard cap from `CreateAccessKey` docs
plus the well-documented `LimitExceeded: "Cannot exceed quota for
AccessKeysPerUser: 2"` message (not spelled out as a literal number in the
API reference page itself, but confirmed via AWS CLI/SDK behavior reports and
the general IAM quotas page's framing of `LimitExceeded`). Correctly treated
as a non-negotiable ceiling `check()` must respect, not something to work
around.

---

## 6. rotate-access-key

**This is explicitly not a single atomic operation** — AWS's own documented
rotation workflow (IAM User Guide, "Rotating access keys") is: create new key
→ update every place the old key's credentials are configured → deactivate
old key → (after a soak period, confirming nothing broke) delete old key.
Steps 2 and the decision to proceed past step 3 are inherently manual — Ferry
has no visibility into which of the user's downstream systems/config files
were updated to point at the new key. The plan below is **honest about this
being a two-phase, human-gated process**, not a fabricated single
`reconcile()`.

**check()** — `ListAccessKeysCommand`.
- 2 keys already present → this run is mid-rotation already (or blocked);
  `"exists"`, and `reconcile()` inspects which of the two is older/Inactive to
  decide whether it's safe to proceed to the deactivate/delete phase.
- 1 key → `"missing"` for the "mint the second key" phase.
- 0 keys → `"conflict"`: rotation presumes an existing key to rotate away
  from; this task is not `create-access-key`.

**reconcile()** — modeled as an explicit two-phase state machine gated on a
required param, not a silent single pass:

*Phase A — mint (runs automatically, no confirmation needed since it is
purely additive and reversible):*
1. If only 1 key exists, `CreateAccessKeyCommand` for the new key. Print the
   new secret once (never persisted), and — critically — **do not touch the
   old key in this same run.** Record `newAccessKeyId`/old `AccessKeyId` in
   outputs.
2. Stop here unless `CONFIRM_CUTOVER=true` is set. Log explicitly: "New key
   `<id>` created. Update all configured credentials to use it, confirm the
   application works, then re-run with `CONFIRM_CUTOVER=true` to deactivate
   and delete the old key `<old-id>`."

*Phase B — cutover (only runs when `CONFIRM_CUTOVER=true`, a required
manual-confirmation param, exactly the pattern the prompt asks for):*
3. `UpdateAccessKeyCommand({ AccessKeyId: oldId, Status: "Inactive" })` —
   deactivate, not delete, first. This is reversible (`UpdateAccessKey` can
   flip it back to `Active`) if the cutover turns out to be premature.
4. Optionally hold for an operator-configurable soak window
   (`ROTATION_SOAK_MINUTES`, default 0 = immediate) — implemented as a
   `pollUntil`-style wait if a "confirm nothing broke" callback/health check
   is wired in, otherwise a no-op sleep the operator can opt into.
5. `DeleteAccessKeyCommand({ AccessKeyId: oldId })` — final, irreversible.

**rollback()** — Phase A's rollback: delete the newly minted key only (the
old key was never touched in Phase A, so nothing else to restore). Phase B's
rollback, if reached and something downstream throws: reactivate the old key
(`UpdateAccessKey → Active`) — cannot un-delete once step 5 has run, so
rollback is only meaningful between steps 3 and 5, another argument for
treating deactivate and delete as distinguishable, separately-committed
sub-steps rather than one fused call.

**Idempotency** — re-run with only Phase A done and `CONFIRM_CUTOVER` still
false: `check()` sees 2 keys, `reconcile()` re-logs the same "waiting on
manual cutover" message, no new mutation. Re-run with `CONFIRM_CUTOVER=true`
after the old key is already `Inactive`: `UpdateAccessKey` to `Inactive` again
is a safe no-op; `DeleteAccessKey` on an already-deleted key is tolerated as
success per the shared `isNoSuchEntity` idiom.

**Determinism** — mint-before-deactivate-before-delete is a hard invariant
(never delete/deactivate before the new key is confirmed minted), same
"hard gate, not best-effort" framing as delete-bucket-with-transfer's
copy-then-delete ordering.

**Ordering** — depends on the user having exactly one existing key (or being
mid-rotation with two); logically composes `create-access-key` (task 5, with
`ALLOW_SECOND_KEY=true` implied) for Phase A and `deactivate-access-key`
(task 7) + a delete for Phase B. Whether this integration literally calls
those two integrations' step factories or just duplicates two short API calls
is a judgment call; given how small each piece is (one `UpdateAccessKey`,
one `DeleteAccessKey`), reuse-via-shared-helper-functions (not full
integrations) in `src/providers/aws/iam.ts` is the right grain — an
`iamAccessKeyStatusStep` factory for the deactivate half, shared with task 7.

**verify()** — Phase A: new key authenticates (same propagation-retry
`GetCallerIdentity` probe as task 5). Phase B: old key is confirmed either
`Inactive` or absent (via `ListAccessKeysCommand`, tolerant of it no longer
being listed at all post-delete) and a call attempted with the old
credentials is confirmed to fail (`InvalidAccessKeyId` / an explicit denied
response), proving the cutover actually took effect and isn't just recorded
in Ferry's own outputs.

**Configurable params** — `IAM_USER_NAME`, `CONFIRM_CUTOVER` (bool, default
false — the manual gate), optional `ROTATION_SOAK_MINUTES`.

**Step decomposition** — two steps in sequence within one integration
(`mint-new-key` then `cutover-old-key`), where the second step's `check()`
itself encodes "has `CONFIRM_CUTOVER` been set, and is there still an old key
to retire" — deliberately not one step, because the two phases have
genuinely different risk profiles (additive/reversible vs. destructive) and
Ferry's plan output should show the operator distinctly whether a run is
about to *mint* or about to *delete*, not collapse both into one opaque
"reconcile".

**Sanity check** — This is the task the prompt most explicitly flagged as
needing honesty about manual process, and the research confirms that framing:
AWS's own docs describe rotation as create → update apps (manual, external to
IAM) → deactivate → delete, with no atomic "rotate" API call existing at all.
The `CONFIRM_CUTOVER` gate is Ferry's own invention to encode the "update
apps" manual step as an explicit, required human decision rather than a
skipped concern — this is a reasonable design choice but is a genuine
judgment call, not something docs.aws.amazon.com prescribes; another
reasonable design would split this into two separate integrations entirely
(`create-second-access-key` / `retire-old-access-key`) rather than one
integration with an internal phase gate. Flagging this as an open design
question rather than asserting the two-step-single-integration shape is the
only correct one.

---

## 7. deactivate-access-key

**check()** — `ListAccessKeysCommand({ UserName })`, find the target key by
`AccessKeyId` (a required param — deactivating "a" key ambiguously when a
user may hold two is not safe; the caller must name which one).
`"missing"` if that `AccessKeyId` isn't found on the user at all (already
deleted, or never existed — `check()` should distinguish this from "found but
already Inactive," which is `"exists"` with nothing to do). Key found and
`Active` → the actionable state.

**reconcile()** — no `create()` (inverted create-or-skip, like task 4):
1. `UpdateAccessKeyCommand({ UserName, AccessKeyId, Status: "Inactive" })`.
2. Capture prior status (`Active`) in outputs for rollback.

**rollback()** — `UpdateAccessKeyCommand({ Status: "Active" })`, restoring
exactly the prior state — this is fully reversible, unlike delete, which is
the whole reason AWS's own rotation guidance recommends deactivate-then-wait
before delete.

**Idempotency** — re-run against an already-`Inactive` key: `check()` finds
it already `Inactive`, "exists"/skip (no redundant `UpdateAccessKey` call,
though even a repeat call would be a harmless no-op — `UpdateAccessKey` is a
whole-value-set operation with only two/three valid states, not additive).

**Determinism** — none.

**Ordering** — standalone; also the exact Phase B, step 3 sub-operation of
task 6 — same shared `iamAccessKeyStatusStep` factory, parameterized by
desired status (`Active`/`Inactive`), the same "opt-in desired-value
converge" idiom as `s3VersioningStep`'s `desired(params)` parameter.

**verify()** — `ListAccessKeysCommand` confirms `Status: Inactive`; optionally
confirm a call made with that key's credentials is now denied
(same negative-control idea as create-backend-s3-user's
`ListAllMyBuckets` check, here checking the *key itself* is unusable rather
than checking scope).

**Configurable params** — `IAM_USER_NAME`, `ACCESS_KEY_ID` (which of the up
to two keys to target).

**Step decomposition** — one step, reusing the same shared
`iamAccessKeyStatusStep` factory proposed for task 6's cutover phase, with
`desired: "Inactive"` fixed and `desired: "Active"` as this same factory's
reactivation counterpart (a reactivate-access-key task isn't in this list of
12, but the factory naturally supports it as a free side effect of the
"opt-in desired value" shape — worth noting for future phase-2b scope, not
building now).

**Sanity check** — Matches `UpdateAccessKey` docs exactly: `Status` valid
values are `Active | Inactive | Expired` (an `Expired` value exists in the
API but has no documented path to set it via this call in normal use — worth
a one-line comment in the step's own doc-comment, not a plan-level concern).
No propagation-consistency issue documented for this specific call the way
CreateAccessKey/AttachUserPolicy have; still worth a short retry on
`verify()`'s read-back out of caution, matching the project's general "IAM is
eventually consistent" posture rather than assuming this one call is
special-cased to be instant.

---

## 8. enforce-mfa

**Reframing, per the research above: there is no boolean "require MFA" flag
on an IAM user.** Enforcement is a *policy* mechanism — a `Condition` block
containing `aws:MultiFactorAuthPresent` (existence check) and optionally
`aws:MultiFactorAuthAge` (session-age check), attached to whichever policies
protect the sensitive actions this user should only be allowed after MFA
authentication. This task genuinely decomposes into two independent pieces
that only make sense as a pair:

**check()** — two independent probes, both surfaced in the plan:
1. Device registration: `ListMFADevicesCommand({ UserName })` — any device
   present? `"exists"`/`"missing"`.
2. Policy condition: does the target policy (an existing managed policy this
   user holds, or a dedicated MFA-enforcement policy this integration owns)
   already contain the MFA condition on the relevant statements?
   Since `PutPolicyVersion`/policy documents are whole-document objects (the
   same "whole-document replace" shape `s3BucketPolicyStep` already handles
   for bucket policies), this check fetches the policy's current default
   version (`GetPolicyVersion`) and tests for the condition key's presence.

**reconcile()** (no `create()` — this always converges toward the desired
condition state, same "always-reconcile self-idempotent" shape as
`s3VersioningStep`/`s3BucketPolicyStep`):

*Device half:*
1. If no MFA device is registered and this integration is scoped to
   **virtual** MFA only (the only kind Ferry can programmatically provision
   end-to-end): `CreateVirtualMFADeviceCommand` to allocate a device
   (returns a `SerialNumber`/ARN and a QR/seed). **`EnableMFADevice` requires
   two live, sequential TOTP codes from the device** (`AuthenticationCode1`/
   `AuthenticationCode2`), which by definition only a human (or the human's
   authenticator app) can produce — Ferry cannot supply these itself. So this
   half of the task can only go as far as *provisioning* the device and
   surfacing the QR/seed to the operator in the report/stdout (mirroring how
   the access-key secret is printed once); actually calling `EnableMFADevice`
   must be a distinct, human-completed follow-up step, not something this
   `reconcile()` can finish unattended. Hardware/U2F device registration is
   out of scope entirely — no API exists to "create" a hardware token, only
   to register one a human already possesses via `EnableMFADevice` with codes
   read off it.
2. Realistically: `reconcile()` here does step 1 and then reports
   `"awaiting-human-enablement"` rather than a clean `"exists"` — a genuinely
   different completion state than every other task in this document, and
   worth flagging loudly rather than glossing over.

*Policy half (independent of whether device enablement has completed):*
3. `GetPolicyVersion` on the target policy → parse `Document` → if the MFA
   condition is absent on the relevant statement(s), construct the merged
   document (existing statements + condition added, or a net-new statement)
   and `CreatePolicyVersion({ SetAsDefault: true })` — whole-document replace,
   capturing the prior version id/document for rollback exactly like
   `s3BucketPolicyStep` captures the prior bucket policy JSON.
4. Note IAM keeps only 5 policy versions per policy; if at the cap,
   the oldest non-default version must be `DeletePolicyVersion`'d first —
   worth a real check here (`ListPolicyVersions`), not assumed away.

**rollback()** — policy half: `CreatePolicyVersion` back to the prior
document (or delete the version this run created and reinstate the previous
default via `SetDefaultPolicyVersion` — the *cleaner* rollback, since it
doesn't require reconstructing the prior JSON verbatim). Device half: if a
virtual device was created this run but never enabled, rollback deletes it
(`DeleteVirtualMFADeviceCommand`, valid on an unenabled device); if it was
already enabled by a human before rollback fires, deleting it is destructive
to the user's now-working MFA setup and should instead just warn and leave
it, the same "don't touch what wasn't fully this run's doing" caution as
elsewhere in this document.

**Idempotency** — re-run after a human has since called `EnableMFADevice`
out-of-band: device-half `check()` now reports `"exists"` cleanly; policy-half
is independently idempotent (condition already present → no-op).

**Determinism** — the two halves are independent and order-agnostic between
themselves, but the *human-in-the-loop enablement* has no deterministic
completion point Ferry can wait on — `pollUntil` could poll
`ListMFADevicesCommand` for the device to flip from "created" to associated/
enabled, with a generous timeout and the standard "give up and warn, don't
throw" behavior `pollUntil` already implements, rather than blocking apply
indefinitely.

**Ordering** — depends on the user (task 1) and the target policy already
existing; if the target is a dedicated "requires-mfa" policy this integration
also creates, that create-if-missing step precedes both halves above.

**verify()** — policy half: re-fetch the default policy version, confirm the
condition is present, byte-for-byte structural check (same idea as
create-backend-s3-user's `assertPolicyDocumentMatches`). Device half: if
enabled, `ListMFADevicesCommand` shows it associated; if only provisioned,
`verify()` should not pretend this is complete — it should explicitly assert
"policy condition is live" while separately reporting "device
provisioned but NOT yet enabled — MFA is not actually enforced for this user
until a human completes enablement," so a partial run never reads as a full
success.

**Configurable params** — `IAM_USER_NAME`, `IAM_POLICY_ARN` (target policy to
add the condition to), `MFA_CONDITION_MAX_AGE_SECONDS` (optional, sets
`aws:MultiFactorAuthAge` instead of/alongside a bare existence check),
`PROVISION_VIRTUAL_DEVICE` (bool — whether to also run the device-provisioning
half at all, since some callers may already have out-of-band device
enablement and only want the policy half).

**Step decomposition** — two steps: `mfa-device-provision` (declares
`create()`, since a device either needs creating or doesn't, but its "done"
state is capped at "created," never "enabled," by Ferry itself) and
`mfa-policy-condition` (always-reconcile, no `create()`, same shape as
`s3BucketPolicyStep`). Not one step — the two have entirely different
idempotency shapes and failure modes and conflating them would hide the
human-gate from the plan output.

**Sanity check — this is the task most worth being blunt about.** The
research fully confirms the prompt's premise: there is no per-user "require
MFA" toggle in IAM; enforcement is exclusively a policy-condition mechanism
evaluated only against STS temporary credentials
(`GetSessionToken`/`AssumeRole`), and critically, **long-term IAM user access
keys never carry MFA context at all** — so a policy with an MFA condition
does nothing to constrain a caller using plain access-key auth; it only
constrains callers who first obtained temporary credentials via
`GetSessionToken` with an MFA code. That means "enforce MFA for this
IAM user" as commonly meant (require MFA at console/CLI sign-in, or gate
specific API calls) genuinely requires the *caller's own workflow* to route
through `GetSessionToken`/`AssumeRole` — Ferry attaching a condition to a
policy does not, by itself, force that routing; it only makes the protected
actions unreachable without it. This is worth stating explicitly in the
integration's own README, not just this plan doc, since it's the single
easiest thing about this task to misrepresent as "flip a switch, done."

---

## 9. add-user-to-group

**check()** — `ListGroupsForUserCommand({ UserName })`, test membership in
the target `GroupName`. `"missing"` if absent (including if the user doesn't
exist yet, foldable to `"missing"` the same as task 3's policy attach — an
earlier step creates the user).

**create()** —
1. `AddUserToGroupCommand({ GroupName, UserName })`. Like `AttachUserPolicy`,
   this is naturally idempotent at the API level but Ferry's own `check()`
   must still distinguish "we added this" from "already a member," for the
   same rollback-safety reason as task 3.
2. Record `addedThisRun: true`.

**rollback()** — `RemoveUserFromGroupCommand`, tolerant of
`NoSuchEntityException`.

**Idempotency** — re-run against existing membership: skip.

**Determinism** — none.

**Ordering** — depends on the user (task 1) and the group already existing;
this task does not create the group (out of scope — group lifecycle isn't
among the 12 tasks here, and Ferry's own precedent
(`s3BucketExistsGuardStep`) is to fold a missing dependency to `"conflict"`
rather than reach outside this task's stated purpose to create one).

**verify()** — `ListGroupsForUserCommand` (or `GetGroupCommand` listing
members) confirms membership, with propagation retry.

**Configurable params** — `IAM_USER_NAME`, `IAM_GROUP_NAME`.

**Step decomposition** — one step. Structurally identical to task 3's
attach-policy shape; a shared `genericIamUserGroupMembershipStep` factory
(paralleling the policy-attach factory) is the natural home, since
add/remove-from-group is the same List/Add/Remove triad as
attach/detach-policy just against a different membership relation.

**Sanity check** — Matches `AddUserToGroup`/`ListGroupsForUser` docs exactly.
One real quota worth surfacing in `check()`-time logging: a user can belong to
up to 10 groups by default (an IAM default the account-level quota page
documents alongside "Groups per account: 300 default / 500 max" — worth
a warn-if-near-cap the same spirit as task 3's policy-count warning, though
not something this plan needs to hard-gate on since AWS itself will reject
the 11th membership with `LimitExceeded`).

---

## 10. remove-user-from-group

**check()** — inverted from task 9: `ListGroupsForUserCommand`, is
`GroupName` present? `"exists"` (removable) vs. `"missing"` (already not a
member — skip). Same inverted create-or-skip framing as task 4.

**reconcile()** (no `create()`) —
1. `RemoveUserFromGroupCommand({ GroupName, UserName })`.
2. Capture that this run performed the removal.

**rollback()** — `AddUserToGroupCommand` to restore membership.

**Idempotency** — re-run when already removed: skip.

**Determinism** — none.

**Ordering** — same existence-guard precondition as task 9 (user and group
both already exist).

**verify()** — `ListGroupsForUserCommand` confirms absence.

**Configurable params** — `IAM_USER_NAME`, `IAM_GROUP_NAME`.

**Step decomposition** — inverse direction call of the same
`genericIamUserGroupMembershipStep` factory proposed in task 9.

**Sanity check** — No surprises versus `RemoveUserFromGroup` docs; behaves
exactly like task 4's detach-policy in miniature.

---

## 11. tag-user

**check()** — `ListUserTagsCommand({ UserName })`, compare the desired tag
set (params) against what's currently attached. This is a whole-set
"desired state vs. current state" comparison rather than a boolean presence
check — closer in spirit to `s3VersioningStep`/`s3BucketPolicyStep`'s
"opt-in, always-reconcile" shape than to a plain create-or-skip. Declares no
`create()`; always reconciles, and `reconcile()` is itself the idempotency
check (compute the diff, only call the API if the diff is non-empty).

**reconcile()** —
1. Fetch current tags via `ListUserTagsCommand`.
2. Diff against desired: keys to add/update → `TagUserCommand({ UserName,
   Tags })` (per docs, `TagUser` **overwrites** any existing tag sharing a
   key — it is not a merge-with-conflict, so re-tagging an existing key with
   a new value is safe and expected, not an error); keys present currently
   but absent from desired and marked for removal → `UntagUserCommand({
   UserName, TagKeys })`. Whether "absent from desired" means "leave alone"
   (opt-in, additive-only) or "remove" (fully declarative, whole-set-replace)
   is a real design choice this plan should make explicit rather than
   silently pick: **recommend additive/update-only by default** (never
   silently deletes a tag some other process or console user set, matching
   the project's general "never drift-manage beyond presence" ethos —
   "ferry's job ends at exists and is verified working... never grow into a
   field-by-field diff" per `define.ts`'s own doc-comment on `check()`), with
   an explicit opt-in `PRUNE_UNMANAGED_TAGS` flag for callers that want full
   declarative convergence.
3. Capture the prior value of every key this run touched (added or changed)
   for rollback — not the *entire* tag set, only what was mutated, mirroring
   `s3BucketPolicyStep`'s "capture the prior document" discipline but at
   per-key granularity since `TagUser`/`UntagUser` are set operations, not a
   single document.

**rollback()** — for each key this run added: `UntagUserCommand([key])`. For
each key this run changed: `TagUserCommand` restoring the captured prior
value. For each key this run pruned (only if `PRUNE_UNMANAGED_TAGS` was on):
`TagUserCommand` restoring it.

**Idempotency** — re-run with no drift: diff is empty, no API call made at
all (true no-op, not just "skip create()" — this is the always-reconcile
idiom doing its own idempotency check inline, same as `s3VersioningStep`
checking `priorStatus === desired` before calling `PutBucketVersioning`).

**Determinism** — none; tag operations are unordered and each key is
independent.

**Ordering** — depends on the user existing (task 1); otherwise standalone,
and composable as an optional final step in `create-user` (task 1) itself,
or run independently later — no hard dependency either direction.

**verify()** — `ListUserTagsCommand` confirms the full desired set is
present (and, if pruning was requested, that pruned keys are gone).

**Configurable params** — `IAM_USER_NAME`, the desired tag set (a
`key=value` map param), `PRUNE_UNMANAGED_TAGS` (bool, default false).

**Step decomposition** — one step, aggregate resource
(`{ type: "aws_iam_user_tags", attributes: { tagCount, keys } }`) — tagging
isn't independently-identified-per-tag the way S3 objects or IAM policy
attachments are, so this doesn't warrant an N-item step-factory the way
delete-bucket-with-transfer's object copy doesn't either; it's one aggregate
convergence action against one user.

**Sanity check** — Matches `TagUser`/`UntagUser` docs: max 50 tags per
`TagUser` call (an array-size limit on the request, not a cumulative
per-resource cap — worth confirming separately if the user could already
hold tags near a resource-level cap, though IAM's docs describe the 50 as the
per-request array bound, and tag key/value length limits (128/256 chars) are
both real, worth validating in `params.ts` via zod before ever calling the
API). The additive-vs-prune design choice is a genuine judgment call, flagged
honestly as a choice this plan is making, not an AWS-mandated behavior.

---

## 12. offboard-user

**Full teardown — check() and reconcile() are exactly `delete-user`'s (task
2), reusing the same `iamUserTeardownSteps(userName)` helper proposed there.**
This task's value-add over raw `delete-user` is process framing (an
access-lifecycle event with its own report/audit trail — "who requested
this, when, why") rather than any different AWS API surface. Restating the
sequence here for completeness, since the prompt asks for full depth per
task:

**check()** — `userState(iam, userName)`; `"missing"` → already gone,
nothing to do.

**reconcile()** — identical ordered sequence to task 2:
1. Deactivate + delete all access keys (0–2).
2. Delete login profile if present.
3. Deactivate + delete MFA device(s) if present.
4. Remove from all groups.
5. Detach all managed policies.
6. Delete all inline policies.
7. (Beyond the prompt's own enumerated list, but required by `DeleteUser`'s
   documented preconditions, same gap flagged in task 2's sanity check)
   delete signing certificates / SSH public keys / service-specific
   (git) credentials if any exist.
8. `DeleteUserCommand`.

**rollback()** — identical caveat to task 2: cannot restore deleted secrets
or the login profile password; recreates a bare user and warns loudly about
everything that is unrecoverable, listing exactly what was destroyed (key
count, MFA status, group list, policy list) from values captured into
outputs before each destructive call.

**Idempotency** — identical to task 2: every sub-step tolerant of
"already gone," safe to resume after interruption.

**Determinism** — identical hard gate: all of 1–7 must be empty before 8
(`DeleteUser`) runs, or AWS returns `DeleteConflict`.

**Ordering — the duplication question, answered.** Per the discussion in
task 2: this is **intentional reuse of a shared teardown helper**, not
independent duplication — both `delete-user` and `offboard-user` should
literally call the same `iamUserTeardownSteps()` factory from
`src/providers/aws/iam.ts` for their `steps:` array. The only difference
between the two integrations is `summary`/`report()` framing (offboarding
language, possibly an additional param like `OFFBOARD_REASON` folded into the
report for an audit trail) — there is no justification for two independently
maintained copies of a nine-API-call destructive sequence; a fix to one
(e.g. adding the signing-certificate/SSH-key/git-credential cleanup flagged
as a gap above) must land in both today if they're separate, which is exactly
the kind of drift risk the shared-factory approach eliminates.

**verify()** — identical to task 2: `GetUserCommand` now 404s.

**Configurable params** — `IAM_USER_NAME`, `ALLOW_DESTRUCTIVE_TEARDOWN` gate
(same as task 2), optional `OFFBOARD_REASON` (audit-trail metadata only, not
an API param).

**Step decomposition** — same shared step array as task 2's helper: no
independent N-item factory needed here beyond what's already described (the
per-category list/delete loops in steps 1, 3, 4, 5, 6 are each small,
bounded-cardinality loops — at most 2 keys, a handful of groups/policies —
not the kind of large-N aggregate that would need its own step-factory
treatment the way S3 object transfer does).

**Sanity check** — Structurally this is task 2 with a different name and
report framing; the plan is honest about that rather than inventing false
differentiation. The one legitimate reason to keep them as two separate
integration *entries* (even while sharing the underlying step-factory) is
operational: "offboard a person" and "delete an IAM entity" are invoked by
different teams at different trigger points (HR-driven vs.
infra-cleanup-driven) and having two `integrations/aws/iam/...` folder
entry points with distinct `summary` and `.env.example` framing is a
reasonable UX choice, provided the underlying step logic is not forked.
