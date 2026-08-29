# aws-snowflake — Implementation Plan

This document plans additional depth on the AWS⇄Snowflake boundary beyond
`snowflake/create-storage-s3-integration` (already built). Every fact below
was verified against current Snowflake/AWS docs during a grounded research
pass, then cross-checked against this repo's actual code — reading the real
`steps/`, `policies/`, and `verify.ts` files, not assuming their shape —
before being written down. That second pass changed one conclusion
materially (see §1) and corrected a factual error the initial research
pass made (see §3's sanity check). No code in this document — English-
language algorithm steps only, matching the discipline of
`docs/plan/github.md` and `docs/plan/aws-github.md`.

---

## 1. "Unload pipeline (Snowflake → S3)" — already fully built, no new integration

This is the single most important finding in this document: reading
`create-storage-s3-integration/verify.ts` directly (not just its README or
its name) shows its existing verification step already performs an
**unload**, not a load:

```sql
COPY INTO @stage/setup_test FROM (SELECT CURRENT_TIMESTAMP)
  FILE_FORMAT = (TYPE = CSV) HEADER = TRUE OVERWRITE = TRUE;
```

`COPY INTO @stage FROM (...)` is Snowflake → S3 (unload); the reverse
direction (`COPY INTO mytable FROM @stage`, load) is what a caller does
*afterward*, using the stage this integration already created — and is not
itself exercised by this integration at all. Combined with the fact that
`policies/index.ts`'s `integrationRolePolicy` already grants
`s3:PutObject`/`s3:DeleteObject` in its **default** `ACCESS_MODE=
"read-write"` mode (confirmed by reading the policy builder directly, not
inferred from the integration's name), the conclusion is unambiguous: **an
integration that provisions a Snowflake stage bound to S3, with IAM
permissions sufficient for both directions, verified via a real unload,
already exists in this repo today.** "Unload pipeline" was never a gap —
it's what `create-storage-s3-integration` already is, under a name that
undersells its own scope.

**What's actually worth doing here, if anything** — not a new integration,
three small, optional documentation/naming refinements:
1. The integration's `README.md` and `report()` template currently
   describe the flow in load-oriented language ("proven with a live COPY
   INTO", the report's `## Snowflake` section doesn't mention direction at
   all) — worth an editorial pass calling out explicitly that the stage
   this creates is bidirectional and the verification step specifically
   proves the unload direction, so callers evaluating "do I need a
   separate integration for unloading" find the answer without reading
   `verify.ts` themselves.
2. If a caller specifically wants `ACCESS_MODE="read-only"` (load-only,
   the integration's other supported mode) verified with an actual
   *load-from-an-existing-table* smoke test rather than the current
   generic `LIST`+denied-write proof, that would be a genuinely new
   `verify()` branch — but this plan does not recommend building it
   speculatively; the current read-only proof (confirms `LIST` works and
   a write is denied) is sufficient evidence the restriction is enforced,
   which is what `verify()` exists to guarantee.
3. Nothing about IAM policy, stage creation, or the two-phase trust-policy
   dance needs to change — all three already work correctly for unload
   today, confirmed by direct code read.

### Sanity check

This conclusion reverses the initial (docs-only) research pass, which
proposed a new "unload-only" integration on the theory that the existing
one only proved loading. That theory was wrong, and reading the actual
`verify.ts` file — three lines of SQL — was what corrected it. This is
worth stating plainly as a methodology note for future planning passes in
this project: **verify against this repo's code, not just against
external API docs and the integration's own name/summary line** — the
gap between "what a task is named" and "what it actually does" can be the
whole answer.

---

## 2. snowpipe-auto-ingest

Genuinely new. Wires an S3 bucket to a Snowflake `PIPE` object for
continuous, event-driven ingestion — the classic "did it once by hand in
two different consoles, wrote it down somewhere, lost the notes" setup.

**Verified, corrected ordering**: pipe-first. `CREATE PIPE` must happen
**before** any S3-side configuration, because Snowflake mints and owns the
SQS queue the pipe listens on — the queue's ARN is only knowable by
reading it back off the created pipe (`SHOW PIPES` → `notification_channel`
column). This also means, contrary to an initial (incorrect) assumption
in early research on this task, **there is no IAM policy step needed for
SQS at all** — confirmed: "Snowpipe SQS queues are created and managed by
Snowflake," so the customer/Ferry side never creates a queue and never
grants IAM permissions on one. The only genuinely new AWS-side action is
pointing the **bucket's own** event notification configuration at the
queue ARN Snowflake already owns.

**check()** — Two independent pieces:
1. `DESC PIPE {name}` (or `SHOW PIPES LIKE`) — confirmed pattern, same
   `showsExactly`/`descProperties` shape already used by `descIntegration`
   in the existing storage-integration task. Missing → `"missing"`.
2. `GetBucketNotificationConfigurationCommand` on the target bucket — scan
   the `QueueConfigurations` array for an entry whose `QueueArn` matches
   the pipe's own `notification_channel` value (read from step 1's
   output, not a param — this task cannot know the correct ARN to look
   for until the pipe already exists, same "value isn't knowable until
   apply-time" shape `trustPolicyStep`'s `check()` already has for the
   storage-integration task). If the pipe doesn't exist yet, this half is
   moot — report `"missing"` overall regardless of bucket state.
3. Requires the base storage integration + stage (task 1, i.e. `snowflake/
   create-storage-s3-integration`) to already exist — `"conflict"` if the
   named stage isn't found, same non-auto-create discipline as
   `update-branch-protection`'s missing-branch case.

**reconcile()** — The pipe object itself is create-or-skip (pipes don't
have a meaningful settings-drift surface at this task's scope — changing
a pipe's `COPY INTO` definition after creation requires `ALTER PIPE ...
SET PIPE_EXECUTION_PAUSED = TRUE` first per Snowflake's own docs, a
disruptive operation this task does not attempt automatically). The
bucket notification half is **always-reconcile, but as a targeted merge,
never a blind overwrite** — `PutBucketNotificationConfiguration` is a
full-document-replace API, and a bucket may already have unrelated
notification rules (from other pipelines, other tools) that a naive
"desired state" PUT would silently delete. This task's reconcile always
re-reads the current configuration, adds/updates only the one
`QueueConfiguration` entry it owns (identified by matching `QueueArn` and
a caller-supplied unique `Id`), and writes the merged result back — a
stricter version of the always-reconcile idiom than `s3VersioningStep`
uses, closer in spirit to how `update-branch-protection` captures a full
pre-image for rollback, except here the pre-image matters for every
reconcile, not just for undo.

**create()** —
1. `iamRoleExistsGuardStep`/stage-existence guard against the base
   storage integration's stage.
2. `CREATE PIPE {name} AUTO_INGEST = TRUE AS COPY INTO {target_table}
   FROM @{stage} FILE_FORMAT = (...);`.
3. `SHOW PIPES LIKE '{name}'` → extract `notification_channel` (the SQS
   ARN) into `ctx.outputs`.
4. `GetBucketNotificationConfiguration`, merge in a new
   `QueueConfiguration` (`QueueArn` = the extracted ARN, `Events:
   ["s3:ObjectCreated:*"]`, `Filter.Key.FilterRules` scoped to the
   ingestion prefix), `PutBucketNotificationConfiguration` with the
   merged result.

**rollback()** — `DROP PIPE {name}` (confirmed: pauses and removes
cleanly). Bucket notification: re-fetch current config, remove **only**
the one entry this run added (matched by the same `Id`/`QueueArn` pair
captured at create time — never a blind re-PUT of a captured "before"
snapshot, since other rules may have been added by something else in the
interim; removing precisely one named entry is safer than restoring a
stale full snapshot).

**Idempotency** — Pipe existence + a precise single-entry match in the
notification config, both independently checked; the merge-not-overwrite
discipline is what makes repeated runs safe against a bucket that
accumulates other rules over time.

**Determinism** — Single pipe, single bucket, single queue entry, per
run.

**Ordering** — Hard dependency on task 1 (the base storage integration +
stage) already existing. Real, non-negotiable internal ordering: pipe
must be created and read back before the bucket notification step can
run at all — encode this the same explicit way
`create-storage-s3-integration`'s own header comment states its ordering
constraint ("the step order encodes a circular dependency and is not
rearrangeable").

**verify()** — Drop a real object into the bucket under the watched
prefix, poll `SELECT SYSTEM$PIPE_STATUS('{name}')` (confirmed: reports
ingestion queue depth/last-received-message-timestamp) until it reflects
the test object, then confirm the target table received a matching row —
same "prove data actually moved" standard as the existing storage-
integration's own `verify()`, not just "the API calls returned 200."
Clean up the test object and, if the ingest landed a row, the test row
too.

**Configurable params** — pipe name, target table, source stage (from
task 1), ingestion prefix/filter, bucket name (must match task 1's
bucket).

**Step decomposition** — Two steps: `pipeStep` (new) and
`bucketNotificationMergeStep` (new — this merge-not-overwrite logic is
genuinely new to this codebase; `s3VersioningStep`/`s3BucketPolicyStep`'s
existing always-reconcile steps are whole-document, not merge, so this is
not a drop-in reuse of an existing factory, only a similar spirit).
`resource()` reports `{ type: "snowflake_pipe", attributes: { name,
notificationChannel, bucket } }`.

### Sanity check

The pipe-owns-the-queue fact and the pipe-first ordering are both
directly off current Snowflake docs on automating Snowpipe for S3 — this
removed an entire (incorrect) IAM/SQS-policy step from this task's design
partway through this research pass, which is worth stating so whoever
builds this doesn't re-add it "just in case." The merge-not-overwrite
requirement for the bucket notification config is this task's own most
important judgment call, not an API-mandated detail — an alternative,
simpler design could require the bucket be dedicated solely to this
pipeline (no other notification rules ever), sidestepping the merge logic
entirely; this plan rejects that simplification because it would make
this task unsafe to run against any bucket a caller might reasonably want
to share across pipelines, but it's a real tradeoff worth confirming with
reviewers.

---

## 3. external-function-to-lambda

Genuinely new, and the most structurally involved task in this document.
Wires a Snowflake `EXTERNAL FUNCTION` to invoke an AWS Lambda through API
Gateway — lets SQL call out to arbitrary compute mid-query.

**Verified dependency graph** (confirmed against Snowflake's own external-
functions setup docs): Lambda and API Gateway must exist and be
**deployed** (a real, live invoke URL) *before* the Snowflake `API
INTEGRATION` object is created, because `api_allowed_prefixes` and the
external function's `AS '<url>'` clause both need a real URL to point at.
This task takes the Lambda + API Gateway resource as **pre-existing
inputs** (an ARN/invoke-URL param), not something it provisions itself —
building a generic "Lambda + API Gateway proxy" bootstrap is a
substantially different, more open-ended integration (arbitrary function
code, arbitrary routing) left explicitly out of scope here, the same way
this plan's `cloudformation-deploy-role-for-actions` task declined to
invent a generic minimal policy for arbitrary Terraform-managed
infrastructure.

**This is the second occurrence of the "placeholder trust policy → read
real principal from the external system → patch to real trust policy"
dance** already built once for `create-storage-s3-integration`
(`steps/iam-role.ts` + `steps/trust-policy.ts`, reusing that pattern's
exact shape: `initialRoleTrustPolicy(accountId)` grants only the account
root, then after `DESC INTEGRATION` reveals `API_AWS_IAM_USER_ARN`/
`API_AWS_EXTERNAL_ID`, `UpdateAssumeRolePolicyCommand` patches to the real
principal gated on the external id). **Correction to an earlier framing of
this task during this research pass**: `github/setup-github-actions-oidc-
role` (already built) does **not** use this pattern — its trust-policy
values (the OIDC provider's ARN, the `sub`/`aud` claims) are fully
deterministic from `accountId` + caller-supplied strings, needing no
placeholder phase at all, confirmed directly from that integration's own
design note ("no placeholder-trust-policy phase was required"). So this
task is the pattern's **second** bespoke copy, not its third — squarely
inside this project's own "two bespoke copies fine" allowance, not a
promotion trigger. A genuine third occurrence, if one arises later, would
be the actual signal to extract a shared `twoPhaseTrustPolicyStep`
factory into `src/providers/aws/iam.ts`; this plan does not recommend
that refactor now, correcting the more aggressive "promote immediately"
recommendation an earlier pass of this research made.

**check()** — Three pieces, same "several independent pieces, checked
jointly" shape as `setup-github-actions-oidc-role`:
1. Does `API_INTEGRATION_NAME` exist (`DESC INTEGRATION`, same
   `showsExactly` shape already used for the storage integration)?
2. Does the placeholder-or-real IAM role exist (`roleState`, reused)?
3. Does `EXTERNAL_FUNCTION_NAME` exist (`DESC FUNCTION`) with its `AS`
   clause matching the supplied invoke URL?

`"conflict"` if the caller-supplied Lambda/API Gateway invoke URL is
unreachable at plan time (a live `HEAD`/`OPTIONS` probe against it,
mirroring the non-auto-create discipline elsewhere in this plan — this
task never provisions the compute side, so a dead URL is a real
precondition failure, not something to silently proceed past).

**reconcile()** — Always-reconcile, whole-document-replace on the trust
policy (identical mechanics to `trustPolicyStep`, reused directly rather
than re-derived — literally the same function shape, parameterized by
`API_AWS_IAM_USER_ARN`/`API_AWS_EXTERNAL_ID` instead of
`storageAwsIamUserArn`/`storageAwsExternalId`). The `api_allowed_prefixes`
list on the `API INTEGRATION` object is treated as a **security boundary,
not a casual setting** — this plan requires any reconcile that would
*widen* the prefix list to log the diff loudly (same instinct as
`update-branch-protection` never silently weakening a protection rule),
though it does not block the widening outright, since a caller may
legitimately need to.

**create()** —
1. Placeholder-trust IAM role (`initialRoleTrustPolicy`-equivalent, reused
   pattern).
2. `CREATE API INTEGRATION {name} API_PROVIDER = aws_api_gateway
   API_AWS_ROLE_ARN = '{placeholder role ARN}' API_ALLOWED_PREFIXES =
   ('{invoke url prefix}') ENABLED = TRUE;`
3. `DESC INTEGRATION {name}` → `API_AWS_IAM_USER_ARN`,
   `API_AWS_EXTERNAL_ID`.
4. Patch the role's trust policy to the real principal (step 2 of the
   two-phase dance, reused shape).
5. `CREATE EXTERNAL FUNCTION {name} (...) RETURNS ... API_INTEGRATION =
   {integration name} AS '{invoke url}';`

**rollback()** — `DROP FUNCTION`, `DROP INTEGRATION`, restore/delete the
IAM role — same ordering and same-run-created gating as
`create-storage-s3-integration`'s existing rollback chain (LIFO handles
this automatically if steps are declared in the order above). The
Lambda/API Gateway resource itself is never touched by rollback, since
this task never created it.

**Idempotency** — Integration/role/function existence independently
idempotent; the trust-policy patch is idempotent by the same
whole-document-replace property as its first occurrence.

**Determinism** — Single integration, single role, single function, per
run.

**Ordering** — Depends on the Lambda + API Gateway resource already being
live (external precondition, out of this task's scope, checked at plan
time per the `"conflict"` case above).

**verify()** — A real `SELECT {external_function_name}(...)` call,
confirming the round trip actually reaches the Lambda and returns a
value — same "prove data actually moved" standard as task 1/2's verify
steps, not merely confirming the DDL objects exist.

**Configurable params** — integration name, IAM role name, Lambda invoke
URL / API Gateway resource ARN (pre-existing, supplied), allowed URL
prefixes, external function name + signature (arg types, return type),
a smoke-test invocation payload for `verify()`.

**Step decomposition** — Five steps, four of which directly reuse the
existing two-phase-dance shape (placeholder role, integration create,
desc-integration, trust-policy patch) parameterized differently, plus one
genuinely new step (`externalFunctionStep`). `resource()` reports `{
type: "snowflake_external_function", attributes: { name, integrationName,
invokeUrl } }`.

### Sanity check

The Lambda-and-API-Gateway-must-be-live-first ordering and the two-phase
trust-policy mechanics are both directly off Snowflake's external-
functions setup docs, cross-checked against this repo's actual
`trust-policy.ts` implementation for the reuse claim. The correction
above (second occurrence, not third — no promotion needed yet) is the
single most important edit this planning pass made relative to its own
first draft, and is called out explicitly rather than silently fixed, so
a reviewer can see the reasoning changed and why.

---

## 4. secrets-manager-snowflake-keypair-sync

Genuinely new, and the one task in this document that requires an
explicit, flagged departure from an existing security stance already
established elsewhere in this codebase — stated up front rather than
buried, since it's the single most important thing for a reviewer to
weigh before this gets built.

**The departure**: `snowflake/rotate-user-key-pair` (already built)
deliberately **never generates or touches private key material** — its
own `mint-new-key` step takes `NEW_PUBLIC_KEY` as a caller-supplied input
and only ever runs `ALTER USER ... SET RSA_PUBLIC_KEY = ...`, confirmed
directly from its step code. The private key, in this codebase's existing
design, is generated entirely outside Ferry's reach — the same stance
`github/create-deploy-key`'s plan takes ("private key generation, if
needed, happens outside this integration's scope"). A task that
automates "generate a Snowflake service-user credential and land it in
Secrets Manager" **cannot** honor that stance and still be useful — the
entire point is a machine-to-machine credential nobody has to
hand-generate and copy-paste. This task must therefore **generate the RSA
key pair itself**, hold the private half in memory for exactly as long as
it takes to write it to Secrets Manager, and never write it to
`ctx.outputs`, a log line, or `resource()` — the same secret-hygiene
discipline already applied everywhere else in this project, but applied
to a genuinely new category of secret this codebase has not generated
before. **Flag this design choice for explicit reviewer sign-off before
building** — an alternative, more conservative design would keep key
generation as a manual/external step (matching `rotate-user-key-pair`'s
existing stance exactly) and have this task only handle the Secrets-
Manager-side push of an already-generated key, at the cost of not being a
true one-shot bootstrap for this use case.

**check()** — `DESC USER {user}` — if the user doesn't exist, `"conflict"`
(this task does not create Snowflake users; compose with
`snowflake/create-role` and a user-creation task, or an existing
onboarding integration, first). If the user exists: compute a SHA-256
fingerprint of the **desired** public key (deterministic from the private
key this run would generate, or — if a key pair for this sync already
exists from a prior run, tracked via a tag on the AWS secret, see below —
of the key pair a prior run generated) and compare it against
`RSA_PUBLIC_KEY_FP`, the field Snowflake itself exposes and keeps current
(confirmed via `DESC USER`'s documented output, and the same fingerprint-
based verification concept `rotate-user-key-pair`'s own report text
already gestures at). This is the load-bearing idempotency mechanism:
**the direction of comparison is reversed from
`sync-secrets-manager-to-github-secrets`** (already built) — that task
tags the *AWS-side* secret with a version id and treats AWS as the
version-of-record; this task must instead treat **the AWS Secrets
Manager secret's own tag** as the record of "which fingerprint was last
synced," since Snowflake exposes no monotonic version number the way
Secrets Manager's `VersionId` is. Concretely: `DescribeSecret` on the
target AWS secret, read a `ferry:synced-pubkey-sha256` tag, compare
against the live `RSA_PUBLIC_KEY_FP` computed the same way Snowflake
computes it (SHA-256 of the DER-encoded public key, base64 — confirmed
format). Match → `"exists"`. Mismatch or no tag yet → `"missing"`.

**reconcile()** — N/A; create-or-skip keyed on the fingerprint tag, same
create-or-skip-not-always-reconcile stance `github/create-or-update-repo-
secret` takes and for the identical reason (avoid needless credential
churn on every apply when nothing has actually changed).

**create()** —
1. Generate a fresh RSA key pair locally (PKCS8, matching the format this
   repo's own `SNOWFLAKE_PRIVATE_KEY` credential loader already accepts —
   confirmed against the root `.env.example`'s documented format:
   "raw PEM (PKCS8) or base64-encoded on one line, both detected
   automatically" — so a key this task generates is directly usable as a
   future `SNOWFLAKE_PRIVATE_KEY` value for whatever service authenticates
   as this user).
2. `ALTER USER {user} SET RSA_PUBLIC_KEY = '{public half}';` (same DDL
   `rotate-user-key-pair`'s `mint-new-key` step already uses — this task
   targets slot 1 directly rather than the two-slot rotation dance, since
   it's provisioning a fresh credential for a service user, not rotating
   a live one out from under active connections; if zero-downtime
   rotation is later needed for this same user, `rotate-user-key-pair`
   composes on top of this task's output, not the other way around).
3. `DescribeSecret`/`CreateSecret` (create-or-update, whichever
   `DescribeSecret` shows) with the private key as the secret value.
4. `TagResource` on the AWS secret with `ferry:synced-pubkey-sha256` =
   the fingerprint of the key pair just created.
5. The private key exists only in local process memory across steps 1–4
   of this single step's `create()` call — never written to
   `ctx.outputs`, `resource()`, or any log line, verified the same way
   `test/integrations/github-secrets-sync-steps.test.ts` already asserts
   for the GitHub-direction sync task (`JSON.stringify(outputs)` must not
   contain the secret value).

**rollback()** — Remove the `ferry:synced-pubkey-sha256` tag only (so the
next run's `check()` correctly re-detects "needs sync" rather than
believing a rolled-back state is current) — never `UNSET RSA_PUBLIC_KEY`
on the Snowflake side and never delete the AWS secret, since by the time
rollback runs, a real consuming service may already have started using
the new credential; undoing the credential itself would break that
service, a materially worse outcome than "the tag is stale." Same
"rollback narrows to what's safely undoable" stance
`sync-secrets-manager-to-github-secrets`'s own rollback already takes.

**Idempotency** — The fingerprint-tag comparison is the whole mechanism;
a re-run against an unchanged Snowflake-side key is a clean skip without
generating a second key pair or touching Secrets Manager a second time.

**Determinism** — Single user, single AWS secret, per run.

**Ordering** — Depends on the Snowflake user already existing.

**verify()** — `DescribeSecret` confirms the tag matches the fingerprint
of the key just generated; `DESC USER`'s `RSA_PUBLIC_KEY_FP` confirms the
Snowflake side matches the same fingerprint — both halves are genuinely
checkable here (unlike the GitHub-direction sync task, where the GitHub
side is permanently write-blind), a real structural advantage of this
direction worth noting: Snowflake's fingerprint exposure makes this the
more thoroughly verifiable of the two "sync a generated credential"
tasks in this codebase.

**Configurable params** — Snowflake user name, target AWS secret
name/ARN, `FORCE_ROTATE: boolean` (default `false`, same escape-hatch
shape as the GitHub-direction task).

**Step decomposition** — One step, composing: a new local key-generation
helper (Node's `crypto` module, PKCS8 output — genuinely new to this
codebase, since every existing key-touching task either only ever handles
the public half or, for AWS access keys, lets AWS itself generate the
credential), the existing `ALTER USER ... SET RSA_PUBLIC_KEY` DDL pattern
reused from `rotate-user-key-pair`, and AWS Secrets Manager
create/update/tag calls (reusing the `secretsManager` client already
added to `AwsClients` for the GitHub-direction sync task — no new AWS
client needed). `resource()` reports `{ type:
"snowflake_service_credential", attributes: { user, secretArn,
publicKeyFingerprint } }` — deliberately excluding the private key,
matching every other secret-touching task in this project.

### Sanity check

The reversed idempotency direction (tag the AWS secret with a computed
fingerprint, rather than trusting an AWS-native version id) is a genuine,
confirmed structural difference from the already-built GitHub-direction
sync task, not a simplification — Snowflake exposes no analogue to
Secrets Manager's `VersionId`. The private-key-generation departure from
`rotate-user-key-pair`'s existing stance is this task's central judgment
call and is flagged prominently, not smoothed over — this plan takes the
position that automation is the actual point of this task and the
departure is justified, but explicitly defers final sign-off to whoever
reviews this plan before building, the same way `cloudformation-deploy-
role-for-actions`'s execution-policy-preset question was left open in the
sibling document rather than silently decided.

---

## Summary: what's new here vs. the existing snowflake.md plan

- One idea (§1, "unload pipeline") turned out, on reading the actual code
  rather than trusting the existing integration's name, to already be
  fully built and verified — the most valuable single finding in this
  document, and a methodology note worth carrying into future planning
  passes: read the code, not just the docs and the summary line.
- Two genuinely new integrations: `snowpipe-auto-ingest` (corrected,
  simpler-than-initially-assumed ordering — no IAM/SQS step needed at
  all, since Snowflake owns the queue — but a genuinely new
  merge-not-overwrite bucket-notification reconcile shape this codebase
  hasn't needed before) and `external-function-to-lambda` (the second,
  not third, occurrence of the placeholder-trust-policy two-phase dance —
  correcting an earlier over-eager promotion recommendation from this same
  research pass).
- One genuinely new integration with an explicitly flagged, not-yet-
  resolved design departure: `secrets-manager-snowflake-keypair-sync`
  requires this codebase's first-ever private-key-generation step,
  a real change in security posture from every existing key-handling task
  here, called out for reviewer sign-off rather than decided unilaterally.
