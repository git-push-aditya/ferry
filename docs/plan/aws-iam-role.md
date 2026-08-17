# aws/iam/role — Implementation Plan

This plan follows Ferry's existing conventions, as read from `src/core/define.ts`
(`Step<P>` contract: `check()` returns `"missing" | "exists" | "conflict"`;
`create()` runs only when `check()` returned `"missing"`; `reconcile()` runs
whenever it is defined and `create()` did not run this step), `src/core/engine.ts`
(plan-then-apply, LIFO rollback registered only for steps that actually ran,
`verify()` failure unwinds the whole run), and `src/core/wait.ts`
(`retryWithBackoff` / `pollUntil`).

It reuses the IAM presence helpers already in `src/providers/aws/iam.ts`
(`isNoSuchEntity`, `policyArn`/`roleArn`/`userArn`, `roleState`/`policyState`)
and mirrors the shape of `src/providers/aws/s3.ts`'s shared step factories
(`s3BucketExistsGuardStep` = read-only precondition that folds "missing" into
"conflict"; `s3VersioningStep`/`s3EncryptionStep`/`s3PublicAccessBlockStep`/
`s3BucketPolicyStep` = "always-reconcile, self-idempotent" for whole-document
whole-config-replace APIs). It also follows `create-backend-s3-user`'s existing
IAM step patterns (`iamUserStep`, `iamPolicyStep`, `attachPolicyStep`,
`accessKeyStep`) and `delete-empty-bucket`'s "inverted create-or-skip" delete
semantics.

All facts about the IAM API below (required params, error names, idempotency,
async job models) were verified against `docs.aws.amazon.com/IAM/latest/APIReference`
during drafting — see the per-task "Sanity check" notes for residual
uncertainty and citations.

---

## 1. create-role

check() — `roleState(iam, roleName)` (GetRoleCommand keyed on `NoSuchEntityException`, exactly the pattern `roleState` already implements in `src/providers/aws/iam.ts`). IAM role names are account-scoped, not globally unique like S3 bucket names, so — unlike `ensureBucketState` — there is no third "exists but not ours" state to model: `NoSuchEntityException` → "missing", any successful GetRole → "exists" (this account already owns anything it can GetRole), anything else rethrows.

reconcile() — not defined; this is a pure create-or-skip step, one resource with one identity.

1. `CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify(trustPolicy), Path, Description, MaxSessionDuration, PermissionsBoundary })`. `AssumeRolePolicyDocument` is required and is the trust policy (service principal, cross-account, OIDC federation, etc.) — this is the same document `UpdateAssumeRolePolicy` (task 5) later replaces wholesale.
2. Capture `RoleId`/`Arn`/`CreateDate` from the response into `ctx.outputs` (`roleCreatedThisRun: true`, `roleArn`), so later steps (attach-policy, inline-policy, tag-role) that may run in the same integration or a chained one can `requireOutput` off it, and so `rollback()` knows it owns this role.
3. `MalformedPolicyDocument` (400) on a bad trust policy JSON is a hard config error — do not retry it; only IAM's own eventual-consistency errors are retry candidates (see Idempotency).

rollback() — `DeleteRoleCommand({ RoleName })`, but only after detaching everything this run may have attached: this step's own rollback is a call to the same detach/delete sequence as `delete-role` (task 2) since a `create-role` integration that also attaches a managed policy or an inline policy in later steps must unwind those steps first — the engine's LIFO order already guarantees that (rollback runs attach-policy's rollback before create-role's, since attach-policy ran later). `create-role`'s own rollback body therefore only ever needs to call `DeleteRoleCommand` directly; it must never itself try to detach things it didn't attach.

Idempotency — a second run against the same role name is `check()` → "exists" → skip, matching `iamUserStep`'s pattern exactly. `CreateRole` is not upsert-style: calling it again on an existing role name throws `EntityAlreadyExists`, so `check()` must always run first and `create()` must never be called speculatively.

Determinism — none needed within this step (single API call). Cross-step ordering (e.g. running before attach-policy-to-role in a composed integration) is a hard dependency, not a race.

Ordering — this is the root of the dependency graph for every other task in this document except `create-service-linked-role` (task 8), which creates its own role by a different, service-owned code path. `attach-policy-to-role`, `detach-policy-from-role`, `update-trust-policy`, `create-inline-policy-for-role`, `rotate-role-permissions`, and `tag-role` all assume a role already exists — this is a real, documented precondition (the role either came from a prior `create-role` run, or from a human/Terraform-provisioned role Ferry does not own), not a cycle: none of those tasks' `check()`/`reconcile()` ever calls `CreateRole`.

verify() — `GetRoleCommand` returns and `AssumeRolePolicyDocument` (URL-decoded) deep-equals the trust policy that was requested. For a service-principal trust policy, optionally also assert the principal's account/service string is present verbatim, since IAM silently reformats some Sid/Version whitespace but never changes semantic content.

Configurable params — `ROLE_NAME`, `TRUST_POLICY` (JSON document or a small typed union — service principal / account ARN / OIDC provider ARN + conditions — resolved to a document before the API call), `PATH` (default `/`), `DESCRIPTION`, `MAX_SESSION_DURATION_SECONDS` (must be in `[3600, 43200]` per the verified `Role` schema), `PERMISSIONS_BOUNDARY_ARN` (optional).

Step decomposition — one step (`iamRoleStep`), analogous to `iamUserStep`/`iamPolicyStep`: one named resource, one identity, one rollback. Worth promoting to a shared factory in `src/providers/aws/iam.ts` (e.g. `iamRoleStep<P>`) the same way `s3BucketStep` is shared, since `create-role`, and potentially other integrations that need "ensure this role exists" as a precondition step (mirroring `s3BucketExistsGuardStep`), would otherwise duplicate the same six lines.

resource() reports `{ type: "aws_iam_role", name: roleName, attributes: { arn, roleId } }`.

Sanity check — CreateRole/GetRole/DeleteRole semantics confirmed directly against the AWS API reference. No ambiguity found: role names are account-scoped so the "conflict" state S3 needs never applies here, which is the one place this task's shape genuinely diverges from the `s3BucketStep` template it's modeled on — worth calling out explicitly in the code comment so a future reader doesn't wonder why no `ExpectedBucketOwner`-style ownership check exists.

---

## 2. delete-role

check() — Inverted create-or-skip, same shape as `delete-empty-bucket`'s `deleteBucketStep`: the target state is "the role is gone." `roleState(iam, roleName)` → `NoSuchEntityException` means "already gone" → return `"exists"` (nothing to do, clean no-op on re-run). If the role exists, this step must additionally probe whether it's a service-linked role (`Role.Path` starting with `/aws-service-role/`, or `RoleName` prefixed `AWSServiceRoleFor`) — service-linked roles are rejected by plain `DeleteRoleCommand` with `UnmodifiableEntity` (verified: "service-linked roles are protected AWS resources... you must request the change through that service"), so if the role is service-linked, `check()` returns `"conflict"` rather than attempting deletion here — point the operator at task 8's sibling delete path (`DeleteServiceLinkedRole`, see task 8) instead of failing mid-apply. Otherwise return `"missing"` (deletion still needs to happen).

reconcile() — none; create()-only, mirroring `deleteBucketStep`.

1. `ListAttachedRolePoliciesCommand({ RoleName })` (paginated) — collect every attached managed policy ARN.
2. `ListRolePoliciesCommand({ RoleName })` (paginated) — collect every inline policy name.
3. `ListInstanceProfilesForRoleCommand({ RoleName })` (paginated) — collect every instance profile the role is attached to.
4. For each attached managed policy: `DetachRolePolicyCommand`. For each inline policy: `DeleteRolePolicyCommand`. For each instance profile: `RemoveRoleFromInstanceProfileCommand`. This ordering is not optional — `DeleteRole`'s own documented precondition is that all three attachment types are removed first, and the API returns `DeleteConflict` (409, "attempted to delete a resource that has attached subordinate entities") if anything is left attached when `DeleteRoleCommand` is called.
5. `DeleteRoleCommand({ RoleName })`.
6. Capture into `ctx.outputs` the exact lists of what was detached/removed this run (policy ARNs, inline policy name+document pairs, instance profile names) — this is the only way `rollback()` can know what to re-provision without re-creating an unrelated overlapping state.

rollback() — best-effort, loudly non-authoritative, same posture as `deleteBucketStep`'s rollback and `s3EncryptionStep`'s "restore prior document" pattern: 1) `CreateRoleCommand` to recreate the role shell using the trust policy captured before deletion (this step's `check()`/pre-delete phase must `GetRoleCommand` and stash `AssumeRolePolicyDocument`, `Path`, `MaxSessionDuration`, `Description`, and `Tags` before doing anything destructive); 2) re-`AttachRolePolicyCommand` each captured managed policy ARN; 3) re-`PutRolePolicyCommand` each captured inline policy verbatim; 4) re-`AddRoleToInstanceProfileCommand` each captured instance profile. Warn explicitly that `RoleId` changes on recreation (any resource-policy or trust relationship referencing the old RoleId, e.g. some cross-account bucket policies keyed on `aws:userid`, will not automatically re-authorize) and that any activity/last-used history and any resource state the linked service itself held is unrecoverable.

Idempotency — re-run after a successful delete: `check()` returns `"exists"` (role already gone) → clean skip, exactly the `deleteBucketStep` pattern. Re-run after a partial failure (e.g. crashed after detaching policies but before `DeleteRoleCommand`): `check()` still finds the role present with now-fewer attachments; the list-then-detach-then-delete sequence in step 1-5 is naturally idempotent per-item (detaching an already-detached policy from a fresh listing is simply not attempted again, since the fresh `ListAttachedRolePoliciesCommand` no longer lists it).

Determinism — order across categories (detach managed → delete inline → remove instance profiles → delete role) matters and is a hard invariant per the AWS precondition; order *within* a category (which policy detaches first) is irrelevant. Use `retryWithBackoff` around `DeleteRoleCommand` itself gated on `DeleteConflict`, since a `ListAttachedRolePoliciesCommand` right after a `DetachRolePolicyCommand` can briefly still show the policy attached under IAM's eventual consistency — a fixed retry with backoff (not a poll, since the target condition is "delete succeeds", checkable directly) rides that out.

Ordering — depends on the role already existing (a real precondition — this task never creates one). No cyclic risk with `create-role`: the two tasks never appear together with `delete-role` upstream of `create-role` in the same account for the same name in any sane usage.

verify() — `GetRoleCommand` throws `NoSuchEntityException`. Additionally, if instance profiles were removed (not deleted) as part of cleanup, confirm they still exist independently (this task removes the role *from* the instance profile; it must never delete the instance profile object itself unless explicitly asked, since other roles or EC2 launch configurations may still reference it).

Configurable params — `ROLE_NAME`; optionally `DELETE_INSTANCE_PROFILES_TOO: boolean` (default false) to also `DeleteInstanceProfileCommand` after detaching, per the AWS docs' own "optional" cleanup step — kept opt-in because an instance profile can be shared/renamed independently of any one role's lifecycle.

Step decomposition — one aggregate step, not a step-factory over N attachments: unlike `create-backend-s3-user`'s per-resource steps (one step per named policy attachment, because each attachment there is independently created/rolled-back by this run), here the *set* of attachments is discovered dynamically from IAM at check-time and the whole cleanup is one indivisible pre-condition-then-delete transaction, the same reasoning the sample `delete-bucket-with-transfer` doc gives for "copying N objects doesn't fit the step-factory pattern." `resource()` reports `{ type: "aws_iam_role", name: roleName, attributes: { arn, action: "deleted", detachedPolicyCount, deletedInlinePolicyCount, removedInstanceProfileCount } }`.

Sanity check — DeleteRole's preconditions (detach managed, delete inline, remove from instance profile, first) and its `DeleteConflict`/`UnmodifiableEntity` errors are confirmed verbatim from the API reference. One open structural question: should `delete-role` refuse outright on a service-linked role (current design, returning "conflict" and pointing at a separate `DeleteServiceLinkedRole` path), or should it detect and transparently redirect to the async `DeleteServiceLinkedRole`/`GetServiceLinkedRoleDeletionStatus` flow itself? This plan takes the former, more conservative option — mixing a synchronous delete-role step with an async polling step under one `check()`/`create()` contract would strain the Step interface's single-phase model, and a human explicitly asking to delete a service-linked role is rare enough to deserve its own dedicated task rather than a silent branch here.

---

## 3. attach-policy-to-role

check() — `ListAttachedRolePoliciesCommand({ RoleName })`, `.some(p => p.PolicyArn === arnOf(ctx))` → `"exists"` : `"missing"`, exactly `attachPolicyStep`'s existing pattern in `create-backend-s3-user/steps/attach-policy.ts`, generalized from `ListAttachedUserPoliciesCommand`/`AttachUserPolicyCommand`/`DetachUserPolicyCommand` (user-scoped) to their role-scoped siblings (`ListAttachedRolePoliciesCommand`/`AttachRolePolicyCommand`/`DetachRolePolicyCommand`). If the role itself doesn't exist yet, `ListAttachedRolePoliciesCommand` throws `NoSuchEntityException` — caught and treated as `"missing"` (an earlier `create-role` step, if chained in the same integration, will create it first), matching the existing `attachPolicyStep`'s `isNoSuchEntity` catch.

reconcile() — none; create-or-skip, one step per policy the same way `attachPolicyStep` is one step per user-policy pair.

1. `AttachRolePolicyCommand({ RoleName, PolicyArn })`.
2. Return `{ policyAttachedThisRun: true }`.

rollback() — `DetachRolePolicyCommand({ RoleName, PolicyArn })`, guarded by `isNoSuchEntity` catch (role or policy already gone by the time rollback runs is a no-op, not an error) — identical to the existing `attachPolicyStep.rollback`.

Idempotency — verified: `AttachRolePolicy`'s API reference documents no "already attached" error in its Errors list (`InvalidInput`, `LimitExceeded`, `NoSuchEntity`, `PolicyNotAttachable`, `ServiceFailure`, `UnmodifiableEntity`) — re-attaching an already-attached policy is a silent no-op on AWS's side. Ferry still gates it behind `check()` regardless, per the existing code comment in `attach-policy.ts`: "the call itself can't tell us whether the attachment is ours. Check first — detaching a pre-existing attachment on rollback would damage state this run did not create." That reasoning applies unchanged to roles: if the policy was already attached before this run (by another process), `check()` returns `"exists"`, `create()` never runs, and `rollback()` is never registered — so a failed later step in the same integration cannot cause this integration to strip a policy attachment it did not add.

Determinism — none needed (single attach call, no ordering dependency among unrelated policy attachments). `LimitExceeded` (409) on the account/role's managed-policy-attachment quota is a hard failure, not retryable — surface it plainly rather than retrying.

Ordering — depends on both the role (task 1) and the managed policy already existing — real preconditions, not cycles. `PolicyNotAttachable` (verified error, 400) specifically covers the case of trying to attach an AWS service-role policy that is reserved for a service-linked role; this task's `check()`/`create()` cannot detect that ahead of time from `ListAttachedRolePoliciesCommand` alone, so it surfaces as a plan-time-passed-but-apply-time-failed error — acceptable here because it is a genuine input-validation error, not a race the phase split was meant to prevent.

verify() — post-attach, `ListAttachedRolePoliciesCommand` contains the ARN (poll with `pollUntil` from `src/core/wait.ts` for a few seconds — IAM attachment visibility is eventually consistent across the console/list APIs, exactly the class of consistency `pollUntil`'s docstring calls out).

Configurable params — `ROLE_NAME`, `POLICY_ARN` (or `POLICY_NAME` resolved to an ARN via `policyArn(accountId, name)` for customer-managed policies, matching AWS-managed policies simply taking a full ARN like `arn:aws:iam::aws:policy/ReadOnlyAccess`).

Step decomposition — one step per (role, policy) pair, matching `attachPolicyStep`'s existing granularity exactly — this is the step-factory shape (N named attachments, each independently created/rolled back), unlike the aggregate `delete-role`. Worth promoting the existing `attach-policy.ts` logic into a shared `iamAttachRolePolicyStep<P>` factory in `src/providers/aws/iam.ts` (parallel to `s3BucketStep`), since `rotate-role-permissions` (task 7) will want to call the identical attach/detach primitives without duplicating them.

resource() reports `{ type: "aws_iam_role_policy_attachment", name: "<role>:<policyArn>", attributes: { role: roleName, policyArn } }`.

Sanity check — AttachRolePolicy's params, errors, and idempotent-attach behavior were verified directly against the API reference and match the existing `attach-policy.ts` code's assumptions one-for-one (only the target changed from user to role). No structural concerns; this is the most directly portable of the ten tasks.

---

## 4. detach-policy-from-role

check() — Inverted create-or-skip (target state: the attachment is gone), same posture as `delete-role`/`deleteBucketStep`. `ListAttachedRolePoliciesCommand({ RoleName })`: if the role itself is `NoSuchEntityException`, treat as `"exists"` (nothing to detach — role's already gone, consistent with the idempotent "already achieved" outcome, not an error). If the role exists and the policy ARN is *not* in the attached list, return `"exists"` (already detached — no-op re-run). If it *is* attached, return `"missing"` (detachment still needs to happen).

reconcile() — none; create()-only.

1. `DetachRolePolicyCommand({ RoleName, PolicyArn })`.
2. Return `{ policyDetachedThisRun: true }`.

rollback() — `AttachRolePolicyCommand({ RoleName, PolicyArn })` to restore the attachment this run removed. Guarded: if the role no longer exists by rollback time (a later step in the same integration deleted it), catch `NoSuchEntityException` and log a warning rather than throwing — the role's absence supersedes needing the attachment back.

Idempotency — a re-run after a successful detach finds the policy no longer attached → `check()` → `"exists"` → skip. A re-run after a crash mid-detach is naturally safe since `DetachRolePolicyCommand` on an already-detached pair is not in this task's path at all (checked first).

Determinism — none needed (single call). No polling required for the detach call itself to be effective for subsequent `DeleteRole` calls in the same run — but if a later step in the same integration is `delete-role`, insert a short `pollUntil` confirming `ListAttachedRolePoliciesCommand` no longer lists the ARN before proceeding, since `DeleteRole`'s subordinate-entity check can otherwise race a very fresh detach.

Ordering — mirror image of task 3; depends on the role existing. This task and `attach-policy-to-role` are the true inverse pair — same status as `create-bucket`/`delete-empty-bucket` in the S3 set.

verify() — `ListAttachedRolePoliciesCommand` no longer contains the ARN.

Configurable params — `ROLE_NAME`, `POLICY_ARN`.

Step decomposition — one step per (role, policy) pair, sharing the same `iamAttachRolePolicyStep`-adjacent factory suggested in task 3 (a `detach` variant, or the same factory parameterized by desired attached/detached state — see task 7 for why a single bidirectional factory is attractive). `resource()` reports `{ type: "aws_iam_role_policy_attachment", name: "<role>:<policyArn>", attributes: { role: roleName, policyArn, action: "detached" } }`.

Sanity check — DetachRolePolicy itself was not separately fetched from the docs this pass (its shape — RoleName + PolicyArn, NoSuchEntity/UnmodifiableEntity errors — is already exercised unchanged in the existing `attach-policy.ts` rollback path and cross-referenced from `AttachRolePolicy`'s and `DeleteRole`'s own pages), so treat the exact error-name list as inherited confidence rather than independently re-verified this pass. No structural concerns otherwise.

---

## 5. update-trust-policy

check() — Always `"missing"` (declares no `create()`), same shape as `s3VersioningStep`/`s3BucketPolicyStep`/`s3EncryptionStep`: the desired trust policy depends on params, not knowable as a static missing/exists at plan time, so `reconcile()` itself is the idempotent check-and-converge.

reconcile() —

1. `GetRoleCommand({ RoleName })` to read the current `AssumeRolePolicyDocument` (URL-decoded JSON).
2. Deep-compare (structural JSON equality, not string equality — IAM may reformat whitespace/key order on read-back) the current document against the desired one. If they already match, log and return `{}` with no API call — a genuine no-op, not just a skip.
3. If they differ, `UpdateAssumeRolePolicyCommand({ RoleName, PolicyDocument: JSON.stringify(desired) })` — this is a **whole-document replace**, exactly like S3's `PutBucketPolicy`/`PutBucketEncryption`: there is no "add one trust statement" API, so the full document must always be supplied.
4. Capture the prior document verbatim into `ctx.outputs.priorTrustPolicy` (stringified) so `rollback()` can restore it exactly, the same shape as `s3BucketPolicyStep`'s `priorBucketPolicy` and `s3EncryptionStep`'s `priorEncryptionConfig`.

rollback() — `UpdateAssumeRolePolicyCommand({ RoleName, PolicyDocument: ctx.outputs.priorTrustPolicy })`, restoring the exact prior document. Unlike `s3VersioningStep`'s "" (never-configured) case, a role's trust policy is **required at creation** — `GetRole` always returns a real `AssumeRolePolicyDocument` — so there is no "no prior config" branch to special-case here; the restore is always a straightforward re-Put of the captured document.

Idempotency — re-running with the same desired trust policy: step 2's deep-compare finds no difference and makes no API call at all — stronger than "safe to re-run," genuinely idempotent with zero side effects on a matching re-run, matching `s3VersioningStep`'s "priorStatus === desired" early-return.

Determinism — single whole-document PUT; no partial-application race exists since `UpdateAssumeRolePolicy` is a single atomic replace. `MalformedPolicyDocument` (verified error, 400) on invalid trust-policy JSON is a hard failure needing no retry.

Ordering — depends on the role already existing — real precondition (this task never creates a role). It has no dependency on tasks 3/4/6 (managed/inline permission policies) since the trust policy and the permissions policies are entirely separate documents/APIs on the same role — no ordering constraint between them.

verify() — re-`GetRoleCommand` and structurally re-compare `AssumeRolePolicyDocument` against the desired document (guarding against IAM's read-back reformatting the same way `check()`/`reconcile()` must).

Configurable params — `ROLE_NAME`, `TRUST_POLICY` (same document/typed-union shape as task 1's `TRUST_POLICY` param — this task is effectively "run task 1's trust-policy shape against an existing role").

Step decomposition — one step (`updateTrustPolicyStep`), single resource, whole-document-replace, always-reconcile — directly analogous to `s3BucketPolicyStep`, and worth writing as close to a literal transposition of that function (swap `GetBucketPolicy`/`PutBucketPolicy`/`DeleteBucketPolicy` for `GetRole`/`UpdateAssumeRolePolicy`, drop the "no policy" `undefined`-means-untouched branch since a trust policy is never absent). `resource()` reports `{ type: "aws_iam_role_trust_policy", name: roleName, attributes: { role: roleName, changed: String(changed) } }`.

Sanity check — UpdateAssumeRolePolicy's single required-params shape, whole-document-replace nature (there is no partial trust-statement API, confirmed by the absence of any such operation in the IAM API reference), and its error set (`MalformedPolicyDocument`, `NoSuchEntity`, `UnmodifiableEntity` for service-linked roles) were verified directly. No structural concerns — this task maps onto Ferry's existing whole-document-replace idiom cleanly.

---

## 6. create-inline-policy-for-role

check() — Always `"missing"` (no `create()`), same always-reconcile shape as task 5 and the S3 whole-document-replace steps — `PutRolePolicy` is documented as "adds *or updates*" a named inline policy, so it is inherently a create-or-replace call, not a separate create-vs-reconcile pair.

reconcile() —

1. Attempt `GetRolePolicyCommand({ RoleName, PolicyName })` to read any existing document under this exact name. `NoSuchEntityException` means the named inline policy doesn't exist yet (fresh create, not an error) — same not-found-is-fine handling as `s3EncryptionStep`'s `GetBucketEncryption` catch.
2. Deep-compare the existing document (if any) against the desired one; if equal, no-op return.
3. `PutRolePolicyCommand({ RoleName, PolicyName, PolicyDocument: JSON.stringify(desired) })` — whole-document replace under that policy name specifically; other inline policies on the same role, under other names, are untouched (inline policies are independently named documents, unlike the trust policy which is a single unnamed slot).
4. Capture `{ hadExistingInlinePolicy: boolean, priorInlinePolicyDocument: string }` into `ctx.outputs`.

rollback() — if `hadExistingInlinePolicy` is false, `DeleteRolePolicyCommand({ RoleName, PolicyName })` (this run created it from nothing, so undo means remove it entirely) — mirrors `s3BucketPolicyStep`'s "delete if we had no prior document" branch. If true, re-`PutRolePolicyCommand` with the captured prior document — mirrors the "restore prior document" branch.

Idempotency — a re-run with the same policy name and same document body: step 2's compare makes the reconcile a true no-op, same as task 5. A re-run with the same policy name but a *changed* document body correctly converges to the new document — this is deliberate "PutRolePolicy is upsert" behavior, not a bug; it is exactly why the step declares no `create()`.

Determinism — single PUT; no multi-step ordering internally. Size/quota errors (`LimitExceeded`, verified in the error list) on aggregate inline-policy-per-role size are hard failures — not retried.

Ordering — depends on the role already existing. No ordering dependency on managed-policy attach/detach (tasks 3/4) — inline and managed policies are independent permission sources evaluated together by IAM, with no API-level interaction between them, so either can be applied in any order relative to the other.

verify() — re-`GetRolePolicyCommand` and structurally compare the returned document to the desired one.

Configurable params — `ROLE_NAME`, `POLICY_NAME` (the inline policy's own name, distinct from any managed policy name), `POLICY_DOCUMENT`.

Step decomposition — one step per (role, inline-policy-name) pair — a step-factory shape if an integration wants to manage several named inline policies on one role (each is independently named and independently reconciled/rolled-back, similar in spirit to `attach-policy-to-role`'s per-attachment granularity, but whole-document-replace per name rather than binary attach/detach). `resource()` reports `{ type: "aws_iam_role_policy", name: "<role>:<policyName>", attributes: { role: roleName, policyName } }`.

Sanity check — PutRolePolicy's "adds or updates" semantics, required params (`RoleName`, `PolicyName`, `PolicyDocument`), and error set (`MalformedPolicyDocument`, `LimitExceeded`, `NoSuchEntity`, `UnmodifiableEntity`) were verified directly. One residual note: DeleteRolePolicy's exact behavior on a name that doesn't exist was not independently fetched this pass — by symmetry with every other IAM delete/get call verified in this document, it is expected to throw `NoSuchEntityException`, and `rollback()` above should defensively catch that (rollback of a role deleted out from under this step, or a policy name collision from elsewhere, should warn, not crash the unwind).

---

## 7. rotate-role-permissions

check() — Always `"missing"` (no `create()`); this is the highest-level always-reconcile step in this document, composing the primitives from tasks 3, 4, and 6 rather than calling a single new AWS API.

reconcile() — "Replace a role's full [managed] policy set in one operation" — read as: converge the role's attached-managed-policy set to exactly the desired set, in a way that never leaves the role momentarily *more* permissive or *fully unpermissioned* mid-run if avoidable.

1. `ListAttachedRolePoliciesCommand({ RoleName })` (paginated) → `currentArns`.
2. Compute `toAttach = desiredArns - currentArns`, `toDetach = currentArns - desiredArns`.
3. **Attach before detach**: for each ARN in `toAttach`, `AttachRolePolicyCommand`. Doing the additions first means that if the run fails partway, the role only ever gains permissions relative to its start state and never loses coverage mid-run — a fail-safe direction for a permissions role (never leave it under-permissioned mid-flight; over-permissioned-briefly is the lesser risk and is fully undone by the next step or by rollback).
4. Only once every `toAttach` attach has succeeded: for each ARN in `toDetach`, `DetachRolePolicyCommand`.
5. Capture into `ctx.outputs` the exact `toAttach`/`toDetach` lists actually executed this run (not just the diff computed at plan time — a partial failure means the executed set may be a strict subset), so `rollback()` unwinds precisely what happened, not what was merely intended.

rollback() — inverse of steps 3-4, using the *executed* lists from outputs, not the desired-state diff: re-`AttachRolePolicyCommand` every ARN this run detached, then `DetachRolePolicyCommand` every ARN this run newly attached — restoring exactly the starting attachment set. Guarded with `isNoSuchEntity` catches throughout (role or policy gone by rollback time).

Idempotency — a re-run against an already-converged role: step 1's fresh listing already matches `desiredArns`, so `toAttach` and `toDetach` are both empty — zero API calls, a true no-op, same standard as task 5's trust-policy compare. A re-run after a partial failure (crashed mid-`toAttach`) resumes correctly: the fresh `ListAttachedRolePoliciesCommand` reflects exactly what succeeded so far, and the diff against `desiredArns` naturally shrinks `toAttach` to only what's still missing and leaves `toDetach` untouched until all attaches are confirmed present.

Determinism — the attach-before-detach *phase* ordering is a hard invariant (never widen the exposure of the fail-safe-direction property above by reordering); the order of ARNs *within* `toAttach` or *within* `toDetach` is irrelevant. `retryWithBackoff` should wrap each individual attach/detach call for `LimitExceeded`-adjacent throttling, not for correctness — none of these individual calls are eventually-consistent in a way that needs `pollUntil` before the *next* call in the same run proceeds, since each call's own success/failure is synchronous and authoritative; a `pollUntil` is only useful in `verify()` for confirming the `ListAttachedRolePoliciesCommand` read-path has caught up.

Ordering — depends on the role already existing (task 1). Explicitly does **not** touch inline policies (task 6) or the trust policy (task 5) — "full policy set" is scoped to managed-policy attachments only, matching the task's own phrasing ("attach new set, detach old set") and keeping this step's blast radius aligned with `AttachRolePolicy`/`DetachRolePolicy`'s own scope. If an integration wants inline policies rotated too, that is a second, separate step calling task 6's factory — not folded into this one, to keep each step's `resource()`/rollback narrowly scoped to one AWS concept.

verify() — `pollUntil`-wrapped `ListAttachedRolePoliciesCommand` confirms the final attached set exactly equals `desiredArns` (as a set, not caring about list order) within a short timeout, riding out the same attachment-visibility eventual consistency task 3's verify() calls out.

Configurable params — `ROLE_NAME`, `DESIRED_POLICY_ARNS: string[]` (the complete target set — not a diff the caller computes themselves, since computing the diff safely, with the attach-before-detach ordering, is exactly this task's value).

Step decomposition — one aggregate step, not N — like `delete-role`, the *set* of attachments to touch is discovered dynamically at reconcile-time against live IAM state and must be handled as one indivisible converge-and-record operation so the attach-before-detach fail-safe ordering can be a single invariant rather than something a per-item step-factory would need to coordinate across independent step instances. It should, however, call the same shared `AttachRolePolicyCommand`/`DetachRolePolicyCommand` wrapper helpers proposed in tasks 3/4 (thin functions, not full `Step` objects) to avoid re-implementing the retry/error-handling twice. `resource()` reports `{ type: "aws_iam_role_policy_set", name: roleName, attributes: { role: roleName, attachedCount: String(desiredArns.length), attachedThisRun: String(toAttach.length), detachedThisRun: String(toDetach.length) } }`.

Sanity check — built entirely from AttachRolePolicy/DetachRolePolicy/ListAttachedRolePolicies, each independently verified in tasks 3/4 above; no new API surface. The one genuine design judgment call (attach-before-detach ordering as the safer failure direction, and recording *executed* not *intended* diffs for rollback) is a Ferry-side policy choice rather than an AWS API fact, and is flagged here as such rather than presented as something the docs mandate.

---

## 8. create-service-linked-role

check() — `roleState`-style probe, but against the service-linked role's own predictable path/name rather than an arbitrary caller-chosen `ROLE_NAME`: most AWS services publish a fixed role name of the form `AWSServiceRoleFor<Service>` (some support a caller-supplied `CustomSuffix`, appended to that fixed prefix — never a fully custom name), so `check()` should `GetRoleCommand({ RoleName: predictableName })` first. `NoSuchEntityException` → `"missing"`; success → `"exists"`.

reconcile() — none; create-or-skip.

1. `CreateServiceLinkedRoleCommand({ AWSServiceName, CustomSuffix?, Description? })`. Verified: this is the one CreateRole-family call in this document that is **not** a bare "throws EntityAlreadyExists on repeat" — for several services the operation is documented and known (from the API's own "if you make multiple requests for the same service, you must supply a different CustomSuffix... otherwise the request fails with a duplicate role name error" note) to have per-service variance in exactly what "already exists" looks like: some services' linked roles are one-per-account, singleton, idempotent-safe-to-recall (creating one that already exists at the same fixed name simply errors distinctly from a fresh create, but functionally the desired end state — role exists — is already true); others use `CustomSuffix` to allow multiple linked roles per account per service, in which case a second call *without* a distinct suffix is a genuine "duplicate" error, not an idempotent no-op. Because this variance is genuinely per-service and not documented as a single uniform rule in the API reference, this step's `check()`-first gate (rather than "just call Create and swallow AlreadyExists") is the load-bearing safety mechanism — never rely on the create call's own idempotency here.
2. On success, capture `Role.Arn`/`Role.RoleName`/`Role.Path` (which will be under `/aws-service-role/<service-principal>/`) into `ctx.outputs`.

rollback() — service-linked roles cannot be deleted with plain `DeleteRoleCommand` (verified: throws `UnmodifiableEntity`). Rollback must instead: 1) `DeleteServiceLinkedRoleCommand({ RoleName })` → returns a `DeletionTaskId`; 2) poll `GetServiceLinkedRoleDeletionStatus({ DeletionTaskId })` with `pollUntil` until `Status` is `SUCCEEDED` or `FAILED`; 3) on `FAILED`, the response includes `Reason.Reason` describing which in-service resources still reference the role (per the verified doc: "the deletion task fails... usually including the resources that must be deleted") — surface that reason directly in the rollback's warning rather than swallowing it, since this is exactly the case where automated rollback cannot complete and a human must intervene in the owning service first.

Idempotency — a re-run when the role already exists: `check()` → `"exists"` → skip, no `CreateServiceLinkedRoleCommand` call at all — this sidesteps the per-service AlreadyExists variance entirely, since Ferry never calls Create against a role its own `check()` already found present.

Determinism — the create call is a single request; the `DeletionTaskId` poll during rollback has no fixed completion time (deletion can be slow if the linked service needs to tear down its own resources first) — use `pollUntil` with a generous timeout and, per its documented behavior, let it warn-and-proceed rather than hang the rollback forever if the timeout is hit, logging the task ID for manual follow-up.

Ordering — self-contained; does not depend on task 1's `create-role`, since `CreateServiceLinkedRole` is a wholly separate creation path with AWS choosing the name/path/trust-policy/managed-policy set, none of which the caller controls the way task 1's caller controls `TRUST_POLICY`. It also has no relationship to tasks 3/4/6/7 (permission-set management) — service-linked roles' permissions are managed by the owning service, not by IAM policy attachment calls at all (confirmed: "To attach a policy to this service-linked role, you must make the request using the AWS service that depends on this role").

verify() — re-`GetRoleCommand` on the resolved name confirms existence and that `Path` matches the expected `/aws-service-role/.../` prefix.

Configurable params — `AWS_SERVICE_NAME` (the service principal string, e.g. `elasticbeanstalk.amazonaws.com` — verified as the exact required format, case-sensitive), `CUSTOM_SUFFIX` (optional; only some services support it — the docs note "if you provide an optional suffix and the operation fails, try again without it," which this integration should surface as actionable guidance in a caught-error message rather than a silent retry, since blindly retrying without the suffix could create a role the caller didn't intend if the original failure was unrelated), `DESCRIPTION` (optional).

Step decomposition — one step, single resource, standard create-or-skip. Not a candidate for the shared `iamRoleStep` factory proposed in task 1, since the check/create mechanics (fixed/predictable name resolution, the CustomSuffix caveat, and the DeleteServiceLinkedRole-based rollback) are different enough to warrant its own function — but it should still reuse `roleState`'s presence-probe shape via a name-resolution helper. `resource()` reports `{ type: "aws_iam_service_linked_role", name: resolvedRoleName, attributes: { arn, awsServiceName, customSuffix: customSuffix ?? "" } }`.

Sanity check — CreateServiceLinkedRole, DeleteServiceLinkedRole, and GetServiceLinkedRoleDeletionStatus's documented shapes were verified directly. The per-service idempotency/uniqueness variance described above is a genuine, AWS-acknowledged ambiguity (the docs describe the CustomSuffix collision behavior in general terms but do not enumerate a master list, in this reference page, of which services are singleton-per-account vs. multi-instance-with-suffix) — this plan deliberately does not assert false certainty about any specific service's behavior and instead designs the check-first gate so Ferry's own correctness never depends on knowing that per-service detail.

---

## 9. tag-role

check() — Always `"missing"` (no `create()`); `TagRole` is documented as a **merge**, not a replace ("if a tag with the same key name already exists, then that tag is overwritten with the new value" — existing keys not mentioned in the request are left alone), so like tasks 5/6 this is inherently an always-reconcile upsert, not a create-vs-update split.

reconcile() —

1. `ListRoleTagsCommand({ RoleName })` (paginated) to read the current tag set — captured in full for rollback, since `TagRole`'s merge semantics mean the "prior state" needed to undo cleanly is the complete prior tag list, not just the changed keys.
2. Compute which of the desired `{Key, Value}` pairs are new or changed relative to current tags.
3. If nothing changed, no-op return (mirrors every other always-reconcile step's short-circuit).
4. `TagRoleCommand({ RoleName, Tags: desiredTags })` — send the full desired set each time; a merge call is safe to call with keys that already match (re-asserting an unchanged key/value is a no-op-effect, same principle as `s3VersioningStep`'s re-Put-of-same-value being harmless).
5. Capture `{ priorTags: JSON.stringify(currentTags) }` into outputs.

rollback() — Two-part, since `TagRole` merges but never removes: 1) `UntagRoleCommand({ RoleName, TagKeys: [keys present in desired but absent from priorTags] })` to strip keys this run introduced that didn't exist before; 2) `TagRoleCommand({ RoleName, Tags: [pairs whose value this run changed] })` restoring the prior value for keys that existed before but were overwritten. Both steps use the captured `priorTags` snapshot exclusively — never attempt to "guess" the pre-run state from anything else.

Idempotency — re-running with the same desired tag set: step 3's compare finds no diffs, zero API calls, true no-op. Re-running with a different desired set correctly re-converges (this is deliberate, matching the task's own description "apply/update tags").

Determinism — single merge call, no ordering dependency between individual tags; `TagRole`'s own quota (`Tags.member.N`, verified maximum 50 items per role) means a request exceeding it fails outright with `LimitExceeded` — no retry, this is a caller-side sizing error to fail loudly on, not a transient condition.

Ordering — depends on the role already existing (task 1). No interaction with any permission-related task (3/4/5/6/7) or with task 8 (service-linked roles are explicitly tag-able too, per `TagRole`'s own text: "The role can be a regular role or a service-linked role" — so this task works unmodified against either role flavor).

verify() — re-`ListRoleTagsCommand` and confirm every desired `{Key, Value}` pair is present (superset check, since other keys this run didn't touch are expected to remain).

Configurable params — `ROLE_NAME`, `TAGS: Record<string, string>`.

Step decomposition — one step, single resource, whole-role tag-merge, always-reconcile — the same category as tasks 5/6, and there is an existing precedent for exactly this pattern already in the codebase: `integrations/aws/s3/tag-bucket` (S3's `TagResource`/`GetBucketTagging` equivalent) should be read alongside this plan as the closer sibling to copy from, even more directly than the versioning/encryption examples, since bucket tagging and role tagging share the identical "merge on write, full-list on read, restore-prior-snapshot on rollback" shape. `resource()` reports `{ type: "aws_iam_role_tags", name: roleName, attributes: { role: roleName, tagCount: String(desiredTags.length) } }`.

Sanity check — TagRole's merge-not-replace semantics, its 50-tag-per-role array maximum, and its error set (`ConcurrentModification`, `InvalidInput`, `LimitExceeded`, `NoSuchEntity`) were verified directly. UntagRole's own page was not independently re-fetched this pass, but its shape (RoleName + TagKeys array, used purely to remove keys) is the standard, symmetric counterpart documented consistently across every other AWS tagging API in this family and is used here only in rollback, a lower-stakes path than the forward reconcile.

---

## 10. audit-unused-roles

check() — This task is a **read-only report**, not a resource lifecycle step in the create/reconcile/delete sense every other task in this document is. It should be modeled the way `verify()`-only or read-only steps are described in `define.ts` ("Omit [create] for a step that only reads... or that only ever reconciles") — a single step whose `check()` always returns `"missing"`, whose `create()` performs the read-and-report work, and which registers **no** `resource()` and an empty `rollback()`, since nothing is ever mutated in AWS. (An alternative framing — no step at all, just integration-level logic in `report()` — is also defensible; this plan keeps it as a step so it participates in the same plan/apply/verify banner and logging the engine gives every other integration, per `engine.ts`'s phase structure.)

reconcile() — N/A (folded into `create()` above, since this "step" never reaches an `"exists"` state worth skipping — every run should re-audit fresh data).

1. `ListRolesCommand` (paginated) — for each role, the returned `Role` object already includes `RoleLastUsed` (verified: `{ LastUsedDate, Region }`, "Activity is only reported for the trailing 400 days... The role might have been used more than 400 days ago") **at no extra API cost** — this is the cheap, synchronous signal and should be the primary/default data source for "candidate for cleanup," not the async job below.
2. Classify each role: `RoleLastUsed` absent entirely → never used (in the trailing tracked window, which may be shorter than 400 days in newer regions per the verified caveat) or the role is very new; `RoleLastUsed.LastUsedDate` older than a caller-supplied threshold (e.g. 90 days) → stale candidate; recently used → not a candidate. Exclude AWS-managed / service-linked roles from the candidate list by default (`Path` starting `/aws-service-role/` or `/service-role/`) unless the caller opts in, since those are typically not safe or meaningful to flag for deletion via this generic audit.
3. **Optional deeper pass**, only for roles flagged as candidates by step 2 (to bound cost/time — this is an N+1 async job pattern, not something to run unconditionally across every role in the account): for each candidate, `GenerateServiceLastAccessedDetailsCommand({ Arn: roleArn, Granularity: "SERVICE_LEVEL" })` → returns a `JobId`; then poll `GetServiceLastAccessedDetailsCommand({ JobId })` with `pollUntil` until `JobStatus` is `COMPLETED` or `FAILED` (verified: "Recent activity usually appears within four hours" for freshness, but the job itself completes far faster than that — it's reporting on already-collected historical data, not waiting four hours synchronously). The result lists every service the role's permissions *could* reach and, per service, the last authenticated-access attempt — this is strictly finer-grained than `RoleLastUsed` (which is a single "last used, in any capacity, anywhere" timestamp) but costs an async round trip per role.
4. Produce the audit output: a list of `{ roleName, arn, lastUsedDate | "never (in tracked window)", region, ageDays, servicesNeverAccessed? }`. This is presented via `report()`/`verify()` output, not applied as any AWS mutation.

rollback() — empty (no-op) — nothing was ever created or changed; there is nothing to unwind. Matches `s3BucketExistsGuardStep`'s "a read-only precondition changes nothing, so there is nothing to undo" comment verbatim in spirit.

Idempotency — trivially idempotent; every run re-lists roles and re-derives the report fresh. No state carried between runs (this plan does not persist a "seen before" ledger — each run stands alone, consistent with Ferry's stated non-goal of drift-tracking per `define.ts`'s own docstring: "ferry's job ends at 'exists and is verified working'... a step must never grow into a field-by-field diff").

Determinism — `ListRolesCommand` pagination order is not guaranteed stable across calls and does not need to be — the report is a set, not a sequence, so no ordering invariant is needed here (unlike `delete-role`'s hard detach-before-delete phase ordering). The optional `GenerateServiceLastAccessedDetails` poll per candidate role should have a firm per-role timeout via `pollUntil` so one slow/failed job doesn't stall the whole audit; a `FAILED` job for one role should be recorded as "detail unavailable" in that role's row and not abort the run.

Ordering — depends on nothing else in this document; it is purely observational and reads global account state (`ListRoles`), not any one role this integration itself manages. It has no "cannot run before X" precondition the way tasks 3/4/5/6/7/9 depend on task 1.

verify() — for a read-only reporting integration, "verify" is necessarily different from every mutation-based task above: it should assert the report was actually produced (non-empty `ListRoles` response handled, at least one page fetched successfully, no unhandled pagination truncation) rather than asserting any AWS-side state changed, since none did. This is the one integration in the set of ten where `verify()`'s job is "prove the read succeeded and the data is trustworthy," not "prove a mutation stuck."

Configurable params — `STALE_THRESHOLD_DAYS` (default e.g. 90), `INCLUDE_SERVICE_LINKED_ROLES: boolean` (default false), `RUN_DEEP_ACCESS_ADVISOR_PASS: boolean` (default false, given its per-candidate async cost), `PATH_PREFIX_FILTER` (optional, to scope the audit to roles under a given path).

Step decomposition — one step, since the work is a single coherent read-then-classify-then-optionally-deepen pipeline over the whole account's role list, not N independent per-role resources with independent identity/rollback — there is nothing to roll back, so the step-factory-per-resource shape (built for independently created/undone resources) doesn't apply here at all. `resource()` is omitted entirely (per `engine.ts`: "Only steps that describe a resource go in the ledger... a step that merely reads... changed nothing there is to hand off").

Sanity check — `RoleLastUsed`'s shape and its documented ≤400-day/region-dependent tracking window, and `GenerateServiceLastAccessedDetails`'s `JobId`-based async model (including the important, verified caveat that "the JobId... must be used by the same role within a session, or by the same user" — meaning the credentials that started the job must be the ones polling it, a real constraint for how Ferry's own root credentials must be used consistently across the generate/poll pair within one run), were both verified directly. The biggest genuine open question in this whole document lives here: "unused" is inherently fuzzy — `RoleLastUsed` reports *any* use, of *any* permission, account-account-wide, while Access Advisor's per-service data can reveal a role that was "used" only for one trivial permission and is otherwise dead weight; this plan treats `RoleLastUsed` as the fast default and the Access Advisor pass as an explicit, costed opt-in precisely because collapsing that nuance into a single boolean "unused" would overstate this task's certainty. Treat any specific numeric staleness threshold as a policy choice for the caller to set, not an AWS-recommended default this plan invents on their behalf.
