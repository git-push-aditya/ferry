# aws-github — Implementation Plan

This document plans four new `github/*` integrations and documents two more
as pure compositions of integrations that already exist — no new code needed
for those two beyond what's already built. Every fact below was verified
against current AWS/GitHub docs during a grounded research pass, then
cross-checked against this repo's actual code (not assumed) before being
written down. No code in this document — English-language algorithm steps
only, matching the discipline of `docs/plan/github.md`.

Everything here builds on `github/setup-github-actions-oidc-role` (already
built): the account-shared OIDC provider for
`token.actions.githubusercontent.com`, plus a role trusting GitHub Actions'
`sub`/`aud` claims. The tasks below **do not re-mint that role or provider**.
Each one either (a) takes an already-created `AWS_ROLE_NAME` as a parameter
and attaches a new scoped permission to it, or (b) creates a second,
differently-trusted role (the CloudFormation execution role, the spoke
roles) that composes with the OIDC role rather than replacing it. This
matches the existing granularity convention in this repo — `aws/s3/
update-bucket-permissions` and `aws/s3/enable-bucket-lifecycle-rules` both
already assume `aws/s3/create-bucket` ran first rather than re-implementing
bucket creation — and avoids a second, divergent copy of the OIDC
trust-policy-building logic in `github/setup-github-actions-oidc-role/
params.ts` (`githubOidcTrustPolicy`/`subClaim`/`oidcProviderArn`).

## 0. A shared-factory gap this plan surfaces

`aws/iam/role/create-inline-policy-for-role` already has exactly the step
shape four of the tasks below need — reconcile a named inline policy on an
existing role to an exact desired document (`PutRolePolicy`/`GetRolePolicy`,
confirmed idempotent-by-verb) — but that step (`steps/inline-policy.ts`)
is **local to that one integration**, not exported from
`src/providers/aws/iam.ts` the way `iamAttachRolePolicyStep` (managed-policy
attach) already is. Building tasks 1–3 below as designed would make this
logic's fourth and fifth occurrence. Per this project's own "two bespoke
copies fine, a third promotes" convention (already invoked for
`aws/iam/role/update-trust-policy`'s pattern and reaffirmed by the AWS⇄
Snowflake plan's task 3), **this plan's first concrete recommendation is:
promote `create-inline-policy-for-role`'s step into a shared
`iamInlinePolicyStep<P>` factory in `src/providers/aws/iam.ts`** (mirroring
`iamAttachRolePolicyStep`'s options shape: `roleName`, `policyName`,
`document`), before or during building task 1. `create-inline-policy-for-
role` itself would then become a one-line consumer of the shared factory,
same relationship `aws/iam/role/create-role` already has to `iamRoleStep`.

---

## 1. ecr-push-access-for-actions

Ferry has no ECR integration today (`grep integrations/aws` confirms no
`ecr` directory exists). This task creates one, scoped narrowly to "let an
existing GitHub OIDC role push images to one repository" — the single most
common "why does our CI need a static AWS key" case in practice.

**check()** — Two independent pieces, checked jointly (same "two pieces of
state" shape as `assign-elastic-ip` and `setup-github-actions-oidc-role`
itself):
1. `DescribeRepositoriesCommand({ repositoryNames: [name] })` — confirmed
   the not-found error is `RepositoryNotFoundException`, not a plain 404
   the way S3/IAM often are; `check()` catches that specific error type,
   same discipline as `isNoSuchEntity`/`isNotFound` elsewhere in this repo.
2. `GetRolePolicyCommand` on the target role/policy name (via the promoted
   `iamInlinePolicyStep`'s own `check()`, reused directly — this task's
   `check()` for the policy half **is** that shared step, not new logic).

Overall: `"missing"` if the repo doesn't exist yet (regardless of the
policy's state — the repo is create()'d first); `"conflict"` if the role
named in `AWS_ROLE_NAME` doesn't exist at all (this task never creates the
OIDC role — same non-auto-create discipline as `add-environment-secret`
requiring its environment to pre-exist); `"exists"` only when both the repo
and the exact-matching inline policy document are present.

**reconcile()** — The inline-policy half is always-reconcile, whole-
document-replace (inherits this from the shared factory — same idiom as
`s3VersioningStep`). The repo half is create-or-skip (ECR repos don't have
a meaningful "drift" surface at this task's scope — `imageScanningConfiguration`
and `imageTagMutability` are set once at creation and this task doesn't
promise to reconcile them, same "create-only, no settings-drift" stance
`create-environment` takes toward its own settings, with a separate task
left as future work if reconcile is ever needed).

**create()** —
1. `iamRoleExistsGuardStep` on `AWS_ROLE_NAME` — conflict if absent.
2. `CreateRepositoryCommand({ repositoryName, imageTagMutability })`.
   Confirmed: `imageScanningConfiguration` on `CreateRepository` is on a
   deprecation path in favor of registry-level scan configuration — this
   task deliberately **omits** it as a per-repo param rather than
   presenting a deprecated option as current best practice, flagged
   explicitly for whoever builds this to re-confirm against the SDK
   version in use.
3. The promoted `iamInlinePolicyStep` against `AWS_ROLE_NAME`, with a
   policy document containing exactly two statements: (a)
   `ecr:GetAuthorizationToken` with `Resource: "*"` — confirmed this
   action cannot be resource-scoped at all; a resource ARN here is a
   silent no-op, so this plan hardcodes `"*"` rather than exposing it as a
   configurable param (a real, easy-to-make mistake worth designing out);
   (b) `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`,
   `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`,
   `ecr:BatchGetImage` scoped to the one repository's ARN.

**rollback()** — Detach (delete) the inline policy statement this run
added if it was newly created (restore the prior document if this run
*changed* an existing one — same prior-document-capture-and-restore
pattern as `trustPolicyStep`/`update-branch-protection`). Delete the ECR
repo only if this run created it, gated behind `ALLOW_DESTRUCTIVE_ROLLBACK
=true` (same gate class as `create-repo`'s GitHub-side rollback) — an ECR
repo can hold images pushed by real CI runs between creation and rollback,
so deleting it is real data loss, not a clean undo.

**Idempotency** — Repo existence check + policy document diff, both
independently idempotent.

**Determinism** — Single repo, single role, single policy document.

**Ordering** — Depends on `AWS_ROLE_NAME` already existing (from
`github/setup-github-actions-oidc-role`, run separately, once, for however
many of these downstream tasks reuse the same role).

**verify()** — `DescribeRepositories` confirms presence; `GetRolePolicy`
confirms the two-statement document matches exactly.

**Configurable params** — `AWS_ROLE_NAME`, `ECR_REPOSITORY_NAME`,
`IMAGE_TAG_MUTABILITY` (`MUTABLE` | `IMMUTABLE`, default `IMMUTABLE` —
safer default, same instinct as `create-deploy-key`'s `read_only` default),
`ALLOW_DESTRUCTIVE_ROLLBACK` (default `false`).

**Step decomposition** — Two steps: `ecrRepoStep` (new, local to this
integration) and the promoted `iamInlinePolicyStep` (shared, from §0).
`resource()` reports `{ type: "aws_ecr_repository", attributes: { name,
uri, roleArn } }`.

### Sanity check

The `GetAuthorizationToken` resource-scoping limitation and the
`imageScanningConfiguration` deprecation are both directly off current AWS
docs, not inferred. `RepositoryNotFoundException` as the specific
not-found error (vs. a generic 404) is the one fact here worth
re-confirming against the exact `@aws-sdk/client-ecr` version at build
time, same "flag lower-confidence spots" convention used for
`create-deploy-key`'s platform-wide-duplicate-key 422 in the GitHub plan.

---

## 2. cloudformation-deploy-role-for-actions

This is the one task in this plan that creates a **second, differently-
trusted** role rather than only extending the existing OIDC role — because
the real best-practice shape (confirmed against current AWS guidance) is a
deliberate two-role split: a narrow CI role (OIDC-trusted, what GitHub
Actions actually assumes) that is only allowed to call
`cloudformation:*` and `iam:PassRole` — nothing else — plus a **separate**
CloudFormation execution role (trusted by `cloudformation.amazonaws.com`,
not GitHub) that holds the actual broad resource-creation permissions
CloudFormation needs mid-deploy. This split exists specifically so a
compromised or over-broad CI token can't directly create arbitrary AWS
resources — it can only ask CloudFormation to do so, and CloudFormation's
own execution role is the actual permission boundary. The generic
`aws/iam/role/create-role` integration already supports an arbitrary trust
policy, so the execution role's creation is not new step logic — this
task's genuinely new contribution is the **PassRole condition**, which is
the single most commonly *missing* permission in hand-rolled CI roles
(teams grant `cloudformation:*` and then hit `AccessDenied: not authorized
to perform iam:PassRole` at deploy time) — exactly the "wiki page gets it
wrong" case this project exists to fix.

**check()** — Three independent pieces:
1. Does `CFN_EXECUTION_ROLE_NAME` exist with the expected trust policy
   (`Principal.Service: "cloudformation.amazonaws.com"`)? Reuses
   `iamRoleStep`'s existing check shape.
2. Does `AWS_ROLE_NAME` (the CI/OIDC role, pre-existing — this task never
   creates it, same non-auto-create discipline as task 1) have the
   expected inline policy attached? (Promoted `iamInlinePolicyStep`.)
3. Does the execution role have its own resource-creation policy attached
   (either a caller-supplied managed policy ARN via
   `EXECUTION_POLICY_ARNS`, or a caller-supplied inline document via
   `EXECUTION_POLICY_JSON` — this plan deliberately does not invent a
   "correct" minimal policy for arbitrary CFN stacks, since **there is no
   universal minimal set** — what a stack needs depends entirely on what
   it deploys; forcing a fake enumerated default here would be Ferry
   inventing a false sense of least-privilege).

`"missing"` if the execution role doesn't exist; `"conflict"` if
`AWS_ROLE_NAME` doesn't exist (real precondition); `"exists"` when all
three pieces match.

**reconcile()** — Always-reconcile on both policy documents (inline
policy on the CI role via the shared factory; the execution role's own
attached policy/policies) — whole-document-replace, same idiom as
elsewhere in this plan. The execution role's own existence is create-or-
skip (via `iamRoleStep`).

**create()** —
1. `iamRoleExistsGuardStep` on `AWS_ROLE_NAME` — conflict if absent.
2. `iamRoleStep` for `CFN_EXECUTION_ROLE_NAME` with trust policy `{
   Principal: { Service: "cloudformation.amazonaws.com" } }`.
3. Attach `EXECUTION_POLICY_ARNS` (via `iamAttachRolePolicyStep`, reused
   directly) and/or `EXECUTION_POLICY_JSON` (via the promoted
   `iamInlinePolicyStep`) to the execution role — at least one of the two
   required by params validation.
4. The promoted `iamInlinePolicyStep` against `AWS_ROLE_NAME` with a
   policy containing: `cloudformation:CreateStack`/`UpdateStack`/
   `DeleteStack`/`DescribeStacks`/`DescribeStackEvents`/
   `DescribeStackResources`/`GetTemplate`, scoped to a stack-name-prefix
   ARN pattern (`STACK_NAME_PREFIX` param, e.g. `arn:aws:cloudformation:
   *:ACCOUNT:stack/myapp-*/*`); **and** `iam:PassRole` scoped to the
   execution role's exact ARN with `Condition: { StringEquals: {
   "iam:PassedToService": "cloudformation.amazonaws.com" } }` — this
   condition is the whole point of this task and is never omitted.

**rollback()** — Detach/restore policies on both roles (prior-document
capture-and-restore, same as task 1); delete the execution role only if
this run created it (gated behind `ALLOW_DESTRUCTIVE_ROLLBACK`, since an
execution role may have been used by a real deploy between creation and
rollback — deleting it would strand any stack that referenced it).

**Idempotency** — Both roles' policy documents are independently diffed
and idempotent; execution-role existence is presence-checked.

**Determinism** — Two roles, two-to-three policy documents, one run.

**Ordering** — Depends on `AWS_ROLE_NAME` (task's own OIDC setup, run
separately). No dependency on the target CFN stack(s) existing — this
task only grants the *permission* to deploy them, same "grants access,
doesn't touch the target resource" scope as `attach-policy-to-role`.

**verify()** — `GetRolePolicy`/`GetRole` on both roles confirms every
document matches exactly, including the `PassRole` condition specifically
(a targeted assertion, not just "a policy exists" — this is the one fact
this task exists to guarantee).

**Configurable params** — `AWS_ROLE_NAME`, `CFN_EXECUTION_ROLE_NAME`,
`STACK_NAME_PREFIX`, `EXECUTION_POLICY_ARNS` (JSON array, optional),
`EXECUTION_POLICY_JSON` (optional; at least one of the two policy inputs
required), `ALLOW_DESTRUCTIVE_ROLLBACK` (default `false`).

**Step decomposition** — Three steps: `iamRoleStep` (execution role,
reused generic factory), `iamAttachRolePolicyStep`/promoted
`iamInlinePolicyStep` (execution role's own permissions), and the promoted
`iamInlinePolicyStep` again (CI role's scoped CFN+PassRole policy).
`resource()` reports `{ type: "aws_cloudformation_deploy_role_pair",
attributes: { ciRoleArn, executionRoleArn } }`.

### Sanity check

The two-role split and the `PassRole` condition's exact shape
(`iam:PassedToService`) are both directly off current AWS guidance for
CloudFormation CI setups. The deliberate choice **not** to invent a
minimal enumerated policy for the execution role's own resource-creation
permissions is a judgment call worth confirming with reviewers — an
alternative design could ship a curated "common starter policy" (e.g.
covering Lambda+API Gateway+S3, the most common CFN-in-CI stack shape) as
an opt-in preset rather than requiring every caller to author their own
JSON from scratch; this plan leaves that as a possible v2 enhancement
rather than blocking v1 on it. This plan explicitly does **not** attempt a
generic Terraform/CDK variant of this task — those tools' permission needs
are open-ended by nature (whatever the code manages), so there's no clean
minimal-policy story the way CloudFormation's role-delegation model
provides; a Terraform-specific task would need to lean on a permissions
boundary + tag-based conditions instead, a meaningfully different (and
weaker-fit-for-Ferry's-idempotent-check-model) design left out of scope
here.

---

## 3. terraform-state-backend-for-actions

**Important correction driving this task's design**: Terraform 1.10
(November 2024) added native S3 state locking via `use_lockfile = true`
(conditional writes to a lock file object inside the same bucket) and
HashiCorp has since **deprecated** the `dynamodb_table` backend option.
Shipping this task as "S3 + DynamoDB, always" in 2026 would itself be the
kind of outdated-wiki-page setup this project exists to replace. This plan
therefore defaults to **S3-only** and does not build a DynamoDB path at
all in v1 (no `dynamodb.ts` exists anywhere in this codebase today —
grepped and confirmed absent — so a DynamoDB variant would also need new
provider-module surface, not just a new integration; deferred as an
explicitly-out-of-scope legacy option rather than half-built).

**check()** — Three pieces, all via already-existing shared factories —
this task adds **no genuinely new step logic of its own** beyond
composing them, which is itself worth stating plainly (same honesty as
`add-environment-secret`'s "no new facts beyond 5+11" note in the GitHub
plan):
1. `s3BucketStep`'s existing check (`HeadBucket`) — missing/exists.
2. The existing `aws/s3/update-bucket-versioning` integration's step logic
   (`GetBucketVersioning`) — confirmed versioning must be `Enabled` for
   S3-native locking's conditional-write mechanism to be meaningful
   (Terraform's own docs require it).
3. The promoted `iamInlinePolicyStep` against `AWS_ROLE_NAME` (pre-
   existing, this task's own precondition like tasks 1–2) scoped to
   `s3:GetObject`/`PutObject`/`DeleteObject` on the state-file key and the
   lock-file object Terraform's native locking writes alongside it.

**reconcile()** — Versioning and the inline policy are both always-
reconcile (reusing the existing `s3VersioningStep`/promoted-factory
shapes exactly). The bucket itself is create-or-skip.

**create()** — `s3BucketStep`'s existing create (`CreateBucket`), then the
existing versioning-enable step, then the promoted inline-policy step.
No new AWS API calls this plan hasn't already covered elsewhere in this
repo.

**rollback()** — Bucket delete only if empty and this run created it
(gated `ALLOW_DESTRUCTIVE_ROLLBACK`, mirroring `delete-empty-bucket`) —
loudly flagged in the README that a state bucket holding real Terraform
state should essentially never actually be rolled back in practice, same
spirit as `create-repo`'s rollback warning. Policy rollback: prior-document
restore, same as tasks 1–2.

**Idempotency** — Fully inherited from the three composed, already-
idempotent factories.

**Determinism** — Single bucket, single role, single policy document.

**Ordering** — Depends on `AWS_ROLE_NAME` pre-existing.

**verify()** — `HeadBucket` + `GetBucketVersioning` (`Enabled`) +
`GetRolePolicy` match.

**Configurable params** — `AWS_ROLE_NAME`, `S3_BUCKET_NAME`,
`STATE_KEY_PREFIX`, `ALLOW_DESTRUCTIVE_ROLLBACK` (default `false`).
Deliberately **no** `USE_DYNAMODB_LOCKING` param in v1 — see above; adding
one later is additive, not a breaking change, if a real need surfaces.

**Step decomposition** — Composes `s3BucketStep`, the existing versioning
step, and the promoted `iamInlinePolicyStep` — no new local `steps/`
files beyond wiring. `resource()` reports `{ type:
"aws_terraform_state_backend", attributes: { bucket, roleArn } }`.

### Sanity check

The Terraform 1.10 native-locking fact and the `dynamodb_table`
deprecation are both directly off current HashiCorp release notes/docs —
this is the single most consequential correction in this entire research
pass, since the "obvious" design (S3 + DynamoDB) is now the *outdated*
one. Confirm the exact OpenTofu-side flag name matches Terraform's
`use_lockfile` before writing this task's README, since that specific
claim was not independently verified against OpenTofu's own docs during
this research pass (flagged as lower-confidence, same convention as
elsewhere in this plan).

---

## 4. github-oidc-spoke-role

The cross-account "N environments, one repo" case. **Important structural
finding**: an IAM OIDC provider is account-scoped — confirmed via the
`CreateOpenIDConnectProvider` API reference, which enforces one
registration per provider URL **per account**. A true multi-AWS-account
rollout therefore cannot share one provider object the way
`github/setup-github-actions-oidc-role` currently assumes (correct for its
own single-account scope). Two real patterns exist: independent per-
account providers, or **hub-and-spoke** (one account holds the OIDC
provider + a hub role; every other account's role trusts the *hub role's
ARN* via ordinary `sts:AssumeRole`, not OIDC directly). This plan adopts
hub-and-spoke as the default, for the same reason several current sources
recommend it: it keeps the OIDC trust surface in exactly one place for
audit purposes, and — just as importantly for Ferry — it avoids inventing
any new multi-credential-set-per-run plumbing. **This task deliberately
does not ask Ferry's engine to hold N AWS credential sets in one run.**
Every existing multi-secret task in this repo (`create-or-update-repo-
secret`, task 5/12's "N secrets = N runs" stance) already establishes the
granularity convention this task follows: one spoke role per invocation,
run once per target AWS account with that account's own `.env` credential
block. The hub (a plain `github/setup-github-actions-oidc-role` run
against the hub account) is a separate, one-time setup this task takes as
a given input (`HUB_ROLE_ARN`), not something it creates.

**check()** — `roleState` (existing `iamRoleStep` shape) on
`SPOKE_ROLE_NAME` in *this* invocation's target account, plus a trust-
policy-content match against the expected hub-role-ARN principal.
`"missing"` if absent; `"exists"` if present and matching; no
`"conflict"` state beyond what `iamRoleStep` already defines (a role that
exists with a *different* trust principal is a real conflict worth
surfacing — reuses `iamRoleStep`'s existing behavior here, not new logic).

**reconcile()** — Always-reconcile the trust policy (whole-document-
replace: `{ Principal: { AWS: HUB_ROLE_ARN }, Action: "sts:AssumeRole" }`
— no `Condition` block needed here, since this is role-to-role trust, not
OIDC-token trust; the *hub* role's own trust policy is what carries the
GitHub OIDC condition, built once via the existing OIDC integration).
Permission-policy attachment (`iamAttachRolePolicyStep`, reused) is
create-or-skip per the existing convention that task already sets.

**create()** — `iamRoleStep` for `SPOKE_ROLE_NAME` with the above trust
policy, then `iamAttachRolePolicyStep` for `SPOKE_PERMISSION_POLICY_ARNS`.

**rollback()** — Detach policies, then restore prior trust policy or
delete the role if newly created — reuses `delete-role`'s existing
teardown logic exactly, same as `setup-github-actions-oidc-role`'s own
rollback already does for its role half. This task never touches the hub
role or the OIDC provider (out of its scope entirely — it doesn't create
either), so there's no "shared infra" blast-radius concern to guard
against the way task 13 of the GitHub plan had to guard the OIDC provider.

**Idempotency** — Standard `iamRoleStep`/attach-policy idempotency,
nothing new.

**Determinism** — Single spoke role, single account, per run — by design
(see above).

**Ordering** — Depends on the hub setup (`github/setup-github-actions-
oidc-role`, run once against the hub account) already having produced
`HUB_ROLE_ARN`. The workflow-side usage is a two-hop `assume-role` chain
(GitHub → hub role via OIDC → spoke role via ordinary AssumeRole),
documented in this task's README/report as a usage example, same as
`setup-github-actions-oidc-role`'s own report includes a workflow-YAML
usage snippet.

**verify()** — `GetRole` on the spoke role confirms the trust policy
matches exactly.

**Configurable params** — `HUB_ROLE_ARN`, `SPOKE_ROLE_NAME`,
`SPOKE_PERMISSION_POLICY_ARNS` (JSON array), `ROLE_DESCRIPTION`.

**Step decomposition** — Two steps: `iamRoleStep` (generic, reused) and
`iamAttachRolePolicyStep` (generic, reused) — this task is almost entirely
composition, with the only genuinely new piece being the trust-policy
document builder (`spokeTrustPolicy(hubRoleArn)`), small enough to live in
this task's own `params.ts`, same placement `githubOidcTrustPolicy` has in
`setup-github-actions-oidc-role/params.ts`. `resource()` reports `{ type:
"aws_iam_oidc_spoke_role", attributes: { roleArn, hubRoleArn } }`.

### Sanity check

The account-scoping of OIDC provider objects is a direct API-reference
fact, not inferred, and materially changes the naive "just reuse the
provider" assumption. The hub-and-spoke-over-N-independent-providers
choice is a design recommendation, not an API constraint — an alternative
plan could instead give this task `credentials: ["aws"]` per account and
rely on N separate `.env` files with N independent OIDC providers (no hub
role, no second hop in the workflow YAML); that avoids the extra
`sts:AssumeRole` hop's latency/failure surface in CI at the cost of
duplicating the OIDC trust surface N times. Worth confirming which
tradeoff reviewers actually want before building, same class of open
judgment call as task 2's execution-policy-preset question.

---

## 5. CI artifact pipeline to S3 — no new integration needed

Verified this composes entirely from integrations already built in this
repo, the same way task 12 of the GitHub plan turned out to be "task 5 +
task 11, no new facts": `aws/s3/create-bucket` (bucket), `aws/s3/update-
bucket-permissions` (the existing `s3BucketPolicyStep` already does
exactly "reconcile a bucket policy to an exact document," which is all a
bucket-side artifact-upload grant needs — a statement allowing
`s3:PutObject`/`s3:GetObject` on `bucket/prefix/*` with `Principal` set to
`AWS_ROLE_NAME`'s ARN, confirmed current best practice favors setting
`Principal` directly to the role ARN with an `aws:PrincipalArn` condition
as defense-in-depth rather than relying on `aws:userid`), and the promoted
`iamInlinePolicyStep` from §0 (role-side permission, run as a standalone
`aws/iam/role/create-inline-policy-for-role` invocation once that step is
promoted and exposed generically, or via task 1's shape reused for a
non-ECR policy). No task-specific orchestration logic is needed beyond
what these three already-composable pieces provide.

One real gotcha worth documenting in whichever README ends up describing
this composition: S3 bucket names are globally unique across *all* AWS
accounts, and in `us-east-1` specifically, re-running `CreateBucket` for a
name the *same* account already owns succeeds silently instead of
returning the `BucketAlreadyOwnedByYou` error other regions return — a
real region-specific idempotency quirk `s3BucketStep`'s existing `check()`
already sidesteps (by checking presence before ever calling `CreateBucket`
at all), but worth calling out explicitly since it's exactly the kind of
gotcha a hand-rolled script would hit.

---

## 6. GitHub Actions cache bucket — no new integration needed

Same finding as §5: `aws/s3/create-bucket` + `aws/s3/enable-bucket-
lifecycle-rules` (already does exactly "reconcile lifecycle rules to an
exact desired set, proven with a config round-trip" — precisely what an
artifact-expiry policy needs) fully cover the bucket side. If self-hosted
runners or a custom `actions/cache`-alternative need write access, that's
the same promoted `iamInlinePolicyStep` pattern as §5, scoped to whatever
role the runner (task 7) assumes.

One gotcha worth flagging for whoever writes this composition's README:
`PutBucketLifecycleConfiguration` auto-generates a rule `ID` if one isn't
supplied, which breaks any future diff-based reconcile — `enable-bucket-
lifecycle-rules`'s existing params should be double-checked to confirm it
already requires/generates deterministic rule IDs (not verified against
that integration's actual `params.ts` during this research pass — a real
follow-up, not an assumption baked into this plan).

---

## 7. self-hosted-runner-registration

This is the one task in this plan requiring a genuinely new EC2-side
capability. **Confirmed real gap**: `aws/ec2/launch-instance`'s current
params (`LOGICAL_NAME`, `AMI_ID`, `INSTANCE_TYPE`, `SUBNET_ID`,
`SECURITY_GROUP_IDS`, `KEY_PAIR_NAME`, `TAGS`) have **no `UserData` and no
IAM instance-profile field** — checked directly against
`integrations/aws/ec2/launch-instance/params.ts`. This task cannot simply
reuse `launchStep` as-is.

**Verified GitHub API choice**: use the **JIT-config** flow
(`POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, or the
`/orgs/{org}/...` variant), not the legacy hour-TTL
`registration-token` endpoint — current GitHub guidance and the tooling
autoscaling controllers use both favor JIT config: no separate `config.sh`
step, the runner starts directly via `run.sh --jitconfig <encoded>`, and
it's single-registration rather than a reusable short-lived token sitting
in plaintext instance metadata.

**check()** — `GET /repos/{owner}/{repo}/actions/runners`, filter by a
naming convention this task controls (`RUNNER_NAME` param, matched
exactly against the `name` field in the response) — **never** call
`generate-jitconfig` from `check()`, since it is a mutating, single-use
call and cannot be treated as a safe idempotent probe (a real, easy
mistake to design around, flagged explicitly the way `trigger-workflow-
dispatch`'s plan flags its own always-`"missing"` read-only-action shape).
`"missing"` if no matching runner is registered; `"exists"` otherwise —
this task does not attempt to detect "registered but the EC2 instance
died," a genuine drift case left as a documented limitation (a caller
needing self-healing should chain this with `aws/ec2/stop-start-instance`-
style health monitoring, out of this task's scope).

**reconcile()** — N/A. A JIT config, once generated, **cannot be
reissued** for an already-registered runner (confirmed: JIT config is a
single-use credential tied to one specific runner registration) — drift
correction for this task is structurally a terminate-and-recreate
operation, not a document-replace reconcile, meaningfully different from
every other reconcile shape in this project's history so far. This plan
does not build automatic terminate-and-recreate in v1; a caller who needs
to replace a runner runs `create()` again after manually deregistering,
same manual-step honesty as `rotate-user-key-pair`'s human-gated cutover.

**create()** —
1. `iamRoleStep` for a new instance role (trust: `ec2.amazonaws.com`) +
   an instance profile (`CreateInstanceProfileCommand` +
   `AddRoleToInstanceProfileCommand` — genuinely new AWS calls this
   codebase hasn't made yet; confirmed EC2 instances need an instance
   *profile*, not a bare role, to receive IAM credentials).
2. `POST .../actions/runners/generate-jitconfig` with `name: RUNNER_NAME`,
   `runner_group_id`, `labels`. Capture `runner.id` into `ctx.outputs`
   **immediately** — this is the only handle this task will ever have to
   deregister the runner later, since it cannot be recovered after the
   EC2 instance is gone.
3. `RunInstancesCommand` with `UserData` set to a small cloud-init script
   that writes the encoded JIT config to disk and execs `run.sh
   --jitconfig <value>`, `IamInstanceProfile: { Arn: <profile arn> }`.
   Confirmed real gotcha: JIT config validity windows are tighter than
   the legacy token's 1-hour TTL — if EC2 boot/provisioning is slow, the
   config can expire before `run.sh` executes; this task's README should
   recommend a fast-booting AMI (pre-baked with the runner binary already
   installed) rather than an install-on-boot UserData script, to keep the
   window small.

**rollback()** — `DELETE /repos/{owner}/{repo}/actions/runners/
{runner_id}` using the captured id **first**, then `TerminateInstances` —
in that exact order, since the runner id cannot be recovered once the
instance (and any local record of it) is gone. Then detach/delete the
instance role and profile if this run created them.

**Idempotency** — Presence-check by name backstops re-runs; the
generate-and-launch sequence itself has no idempotency token (confirmed
no dedup mechanism on `generate-jitconfig`), same "fire-and-log" shape as
`trigger-workflow-dispatch` — a re-run that races a slow-but-still-
succeeding prior run could register a second runner under the same
`RUNNER_NAME` if `check()` runs before the first `create()`'s registration
call lands; documented as a real, low-probability race rather than
claimed as impossible.

**Determinism** — Single runner, single instance, per run.

**Ordering** — No dependency on other tasks in this plan; independent.

**verify()** — `GET .../actions/runners/{runner_id}` confirms `status:
"online"` (best-effort — depends on the runner having actually completed
boot and check-in, which this task should poll for with a bounded
timeout, same shape as `pollUntil` usage elsewhere in this repo) and
`DescribeInstances` confirms `running`/status-ok, same verification depth
as `launch-instance`'s own `verify()`.

**Configurable params** — owner, repo (or org), `RUNNER_NAME`, labels,
`runner_group_id` (optional), `AMI_ID`, `INSTANCE_TYPE`, `SUBNET_ID`,
`SECURITY_GROUP_IDS`.

**Step decomposition** — Three steps, all new local logic (this task
cannot reuse `launch-instance`'s existing `launchStep` verbatim given the
`UserData`/instance-profile gap noted above): the instance-role-and-
profile step, the JIT-config-generation step, and a launch step shaped
like `launchStep` but extended with the two missing fields. **Design
recommendation, not a requirement**: rather than duplicating `launchStep`
wholesale, consider extending `aws/ec2/launch-instance`'s own params with
optional `USER_DATA`/`IAM_INSTANCE_PROFILE_ARN` fields, making it directly
reusable here and by any future task needing the same two fields — this
plan flags the choice rather than deciding it, since it's a real design
tradeoff (generalize an existing integration's params vs. keep this task
fully self-contained) worth a second opinion before building.
`resource()` reports `{ type: "github_self_hosted_runner", attributes: {
owner, repo, runnerId, runnerName, instanceId } }`.

### Sanity check

The JIT-config API, its single-use/non-reissuable nature, and the
tighter validity window relative to the legacy registration-token flow
are all directly off current GitHub docs and changelog material, not
inferred from older tooling conventions. The `launch-instance` params gap
was independently confirmed by reading this repo's actual `params.ts`
during this planning pass, not assumed from the research forks' external
API research alone — this is a real, current fact about this codebase as
of this plan's writing, not a hypothetical.

---

## Summary: what's new here vs. the existing github.md plan

- One cross-cutting refactor recommendation (§0): promote the inline-
  policy reconcile step out of `create-inline-policy-for-role` into a
  shared `iamInlinePolicyStep<P>` factory, since this plan's first three
  tasks would otherwise be its fourth and fifth bespoke copies.
- Four genuinely new integrations: `ecr-push-access-for-actions` (new ECR
  provider surface — this repo has none today), `cloudformation-deploy-
  role-for-actions` (the two-role split + `PassRole` condition pattern),
  `terraform-state-backend-for-actions` (almost entirely composition, and
  a live correction of the DynamoDB-locking assumption against Terraform
  1.10's native S3 locking), and `github-oidc-spoke-role` (the one task
  requiring a real design decision — hub-and-spoke vs. N independent
  providers — flagged for reviewer input rather than silently decided).
- Two ideas (CI artifact pipeline, Actions cache bucket) that turned out,
  on inspection of this repo's actual existing integrations, to need **no
  new integration at all** — just documentation showing how to compose
  `create-bucket` + `update-bucket-permissions`/`enable-bucket-lifecycle-
  rules` + the promoted inline-policy factory. Confirming this by reading
  the code rather than assuming it was itself the most valuable output of
  this planning pass for those two items.
- One task (`self-hosted-runner-registration`) that surfaces a real,
  confirmed gap in `aws/ec2/launch-instance`'s params (no `UserData`, no
  instance-profile field) — flagged as a design choice (extend the
  existing integration vs. duplicate its launch logic locally) rather
  than resolved unilaterally in this plan.
