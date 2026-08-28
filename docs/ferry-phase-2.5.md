# Ferry — Phase 2.5: Prove It, Then Prune It

**Status:** proposed, not started.
**Sits between:** Phase 2 (PR #4, merged/pending) and Phase 3 (Terraform/Ansible handoff).
**Why it exists:** Phase 2 delivered 82 integrations and a proven abstraction. It did not
deliver the other half of its own "done when" — integrations *run and verified against live
resources* — and along the way the catalogue grew a large tail of single-API-call wrappers
that dilute the thesis and cost maintenance forever.

Phase 2.5 does two things and nothing else: **prove the spine against real infrastructure**,
and **cut the tail**. It adds one integration and deletes many.

---

## 0. The thesis amendment this phase depends on

The roadmap's first paragraph says Ferry is *"one-shot, verified, self-cleaning bootstrap of
tedious cross-system setups — not lifecycle management."* The catalogue no longer obeys that,
and it turns out that is **the right instinct badly documented** rather than drift to be
reverted.

The stated goal for Ferry is to be part of the **developer lifecycle for orgs**. That is a
better thesis than genesis-only bootstrap, for one concrete reason:

> Genesis bootstrap happens **once per company**. Developer lifecycle happens **every time
> someone joins, leaves, or rotates a credential** — weekly at a 50-person org.

A tool used once is a tool nobody remembers exists. A tool used on every onboard/offboard is
in the muscle memory. The frequency argument is decisive, and it rescues
`snowflake/onboard-developer-prod`, `snowflake/offboard-developer`, `aws/iam/user/offboard-user`,
`aws/iam/user/rotate-access-key`, `snowflake/rotate-user-key-pair`, and `aws/iam/user/enforce-mfa`
from the "lifecycle drift" charge. Those are the product.

**But the amendment must be explicit, because it is load-bearing for every cut below.**
Amend the roadmap's scope line to:

> Ferry's scope: **one-shot, verified, self-cleaning execution of tedious multi-step
> cross-system procedures** — the genesis bootstraps that happen once, and the
> person-and-credential lifecycle events that recur. Not continuous reconciliation, not a
> state engine, not drift detection.

The word doing the work is **procedure**. A procedure has ordering, has a failure mode
mid-way, and has an outcome you can prove. A single API call has none of those. That is the
cut line for §2.

---

## 1. Prove the spine (do this first — it gates everything)

`docs/handover.md` §6 has been outstanding since the end of Phase 1 and is now 80
integrations stale. **No integration in this repo has ever run against real infrastructure.**
`output/` contains exactly two reports, both dated 2026-07-27, both from the pre-framework
standalone scripts.

Tests prove the logic; only a real run proves the integration. Every eventual-consistency
surprise, IAM propagation timing, and API-shape mismatch lives in the path that has never
executed.

### 1.1 Environment

- A scratch AWS account (**not** a shared one — checks 3 and 4 deliberately create and
  destroy). Long-lived credentials, not the expired `ASIA...` STS tokens that blocked this
  in Phase 1.
- A Snowflake trial account.
- A throwaway GitHub org.

### 1.2 The runs

Handover §6's five checks, plus the Phase 2 headliners:

| # | Run | Proves |
| --- | --- | --- |
| 1 | `snowflake/create-storage-s3-integration` on a clean account | The `COPY INTO` actually lands a CSV. The flagship claim. |
| 2 | Immediate re-run of #1 | Genuine no-op, exit 0. Invariant #1. |
| 3 | Ctrl-C mid-run of #1 | LIFO rollback of only this run's resources. Invariant #2. |
| 4 | `aws/s3/create-backend-s3-user` against a bucket it did not create | Standalone operation. |
| 5 | IAM propagation timings under the reordered trust-policy reconcile | The waits carried over from the old script are still adequate. |
| 6 | `snowflake/snowpipe-auto-ingest` | The merge-not-overwrite bucket-notification reconcile. |
| 7 | `snowflake/external-function-to-lambda` | The second two-phase placeholder-trust dance. |
| 8 | `github/setup-github-actions-oidc-role` | The OIDC provider + role + trust path. |
| 9 | `github/ecr-push-access-for-actions` | The newest provider surface (ECR). |
| 10 | `snowflake/rotate-user-key-pair` | The human-gated cutover, the lifecycle flagship. |

### 1.3 Record the evidence

Add `docs/live-runs.md`: one row per run — date, integration id, account/org used, outcome,
and every surprise found. This file is the credibility artifact. Right now the honest answer
to "has this ever worked?" is "we don't know," and no amount of green CI changes that.

**Exit criterion:** all ten runs recorded, with failures fixed and re-run. Phase 2's "done
when" is only satisfied here, not in PR #4.

---

## 2. Cut the tail

### 2.1 The rubric

An integration earns its folder if it scores on **two or more**:

1. **Multi-step** — two or more mutating steps, where a failure between them leaves a mess a
   human would have to reason about.
2. **Cross-system** — spans two providers, or two services whose consoles are different tabs.
3. **Ordering-sensitive** — a step's input is a prior step's output. The circular
   external-ID dance is the archetype.
4. **Functionally verifiable** — `verify()` does what a *user* would do (move data, assume
   the role, run the pipe), not "read back the field I just wrote."

Scoring zero or one means the equivalent is a documented CLI one-liner, and Ferry's engine
adds ceremony rather than safety.

**Two things that do NOT save an integration:**

- *"It's a dependency root, other integrations reference it."* Verified false as a coupling
  claim: nothing imports anything. The shared step factory in `src/providers/` is what other
  integrations use, and it survives the deletion untouched. The references are prose.
- *"Its verify() is thorough."* Several cut candidates have genuinely careful verifies with
  `pollUntil` and precise error messages. They still only prove the API call landed.

### 2.2 Tier 1 — delete (32)

All are one mutating step, one service, read-back verify, and a documented CLI one-liner.

**EC2 resource CRUD (9)** — instance/volume operations that Terraform, ASGs, and `aws ec2`
already own. Nobody's day is ruined by tagging an instance.

- `aws/ec2/tag-instance`
- `aws/ec2/stop-start-instance`
- `aws/ec2/terminate-instance`
- `aws/ec2/update-instance-type`
- `aws/ec2/resize-ebs-volume`
- `aws/ec2/attach-detach-ebs-volume`
- `aws/ec2/create-ebs-snapshot`
- `aws/ec2/create-ami-from-instance`
- `aws/ec2/assign-elastic-ip`

**IAM policy and group plumbing (7)** — every one of these is a single call that already
exists as a shared step factory. The factory is the artifact; the wrapper is packaging.

- `aws/iam/role/attach-policy-to-role`  (`iamAttachRolePolicyStep`)
- `aws/iam/role/detach-policy-from-role`  (`iamDetachRolePolicyStep`)
- `aws/iam/user/attach-policy-to-user`  (`iamAttachUserPolicyStep`)
- `aws/iam/user/detach-policy-from-user`  (`iamDetachUserPolicyStep`)
- `aws/iam/user/add-user-to-group`  (`iamAddUserToGroupStep`)
- `aws/iam/user/remove-user-from-group`  (`iamRemoveUserFromGroupStep`)
- `aws/iam/user/deactivate-access-key`  (`iamAccessKeyStatusStep`)

**Tagging (3)** — one `Put*Tagging` call each.

- `aws/iam/role/tag-role`
- `aws/iam/user/tag-user`
- `aws/s3/tag-bucket`

**S3 single-setting toggles (3)**

- `aws/s3/update-bucket-versioning`  (86 LOC, one `PutBucketVersioning`)
- `aws/s3/update-bucket-encryption`  (one `PutBucketEncryption`)
- `aws/s3/delete-empty-bucket`  (`aws s3 rb`)

**GitHub repo config CRUD (6)**

- `github/create-webhook`
- `github/create-deploy-key`
- `github/add-remove-collaborator`
- `github/update-branch-protection`
- `github/enable-disable-workflow`
- `github/trigger-workflow-dispatch` — **the clearest cut in the catalogue.** Its own plan
  (`docs/plan/github.md` §10) disqualifies it in its own words:
  `check()` *"always returns `"missing"`"*; **Idempotency:** *"None at the API level
  (confirmed no dedup mechanism); this is inherently a fire-and-log action"*;
  `rollback()`: *"None meaningful — a workflow run, once dispatched, cannot be
  un-dispatched"*; `verify()` with the default `waitForCompletion=false` *"cannot confirm
  the run succeeded, or ran at all."* That is three of the four engine invariants
  (idempotent re-run, rollback of what this run made, live verification) failed by design.
  It is `gh workflow run`.

**Snowflake single-DDL (4)**

- `snowflake/create-warehouse`  (one `CREATE WAREHOUSE`)
- `snowflake/update-warehouse-size`  (one `ALTER WAREHOUSE SET`)
- `snowflake/create-role`  (one `CREATE ROLE`)
- `snowflake/add-public-key-to-existing-user` — superseded by `rotate-user-key-pair` and
  `secrets-manager-snowflake-keypair-sync`, both of which do this correctly as part of a
  real procedure.

### 2.3 Tier 2 — merge (8 folders → 3, net −5)

Each group is the same operation with a different scope parameter. Three folders where one
parameterized integration is honest.

| Merge | Into | Rationale |
| --- | --- | --- |
| `github/create-or-update-repo-secret` + `create-or-update-org-secret` + `add-environment-secret` | `github/set-actions-secret` with `SCOPE=repo\|org\|environment` | The libsodium sealed-box encryption is genuinely fiddly and worth owning — **once**, not three times. |
| `snowflake/grant-role-to-user` + `revoke-role-from-user` + `update-user-role` | `snowflake/set-user-roles` — converge to a desired role set | These are the atoms of onboard/offboard. As a converge-to-desired-set they become one coherent lifecycle primitive instead of three verbs. |
| `aws/s3/delete-bucket-with-download` + `delete-bucket-with-transfer` | `aws/s3/decommission-bucket` with `DRAIN_MODE=download\|transfer` | Same teardown, different drain. The drain is the parameter. |

### 2.4 Tier 3 — a judgment call, needs your input (6)

These are 1-step but sit near the lifecycle thesis. I lean cut on the first three, keep on
the last three, but they are genuinely arguable and I would rather flag than decide.

| Integration | Case to cut | Case to keep |
| --- | --- | --- |
| `github/create-repo` | One `POST /repos`. `gh repo create`. | 11 prose citations as the root of every other `github/*` task. |
| `aws/ec2/launch-instance` | One `RunInstances`. Terraform's core competency. | Needed by §3's runner registration — but §3 has to extend it anyway (no `UserData`, no instance profile). |
| `aws/iam/role/create-role` / `aws/iam/user/create-user` | One `CreateRole`/`CreateUser`. 17 and 14 citations, but all prose. | The `iamRoleStep`/`iamUserStep` factories survive regardless. |
| `aws/iam/role/audit-unused-roles` | Read-only; creates nothing, rolls back nothing; arguably a report, not an integration. | Real org-hygiene value, fits the lifecycle thesis. |
| `snowflake/audit-user-access` | Same read-only shape. | Same lifecycle value; pairs with offboarding. |
| `aws/iam/role/create-service-linked-role` | One call. | Genuinely obscure and easy to get wrong. |

**Recommendation:** cut `create-repo` and `launch-instance` only *after* §3 resolves; keep
the two audits but reclassify them in their READMEs as **reports**, and say plainly that
they create nothing and roll back nothing so nobody expects otherwise.

### 2.5 What is left

| | |
| --- | --- |
| Today | 82 |
| After Tier 1 | 50 |
| After Tier 2 | 45 |
| After Tier 3 (as recommended) | ~42 |
| Plus §3's runner registration | ~43 |

Of those, the **flagship twelve** — the ones that get live runs, READMEs written for
someone arriving from a search engine, and the front of the README:

1. `snowflake/create-storage-s3-integration` (9 steps — the reason this project exists)
2. `snowflake/snowpipe-auto-ingest`
3. `snowflake/external-function-to-lambda`
4. `snowflake/secrets-manager-snowflake-keypair-sync`
5. `snowflake/rotate-user-key-pair`
6. `snowflake/onboard-developer-prod` / `offboard-developer`
7. `aws/s3/create-backend-s3-user`
8. `aws/iam/user/rotate-access-key`
9. `aws/iam/user/offboard-user`
10. `github/setup-github-actions-oidc-role`
11. `github/ecr-push-access-for-actions`
12. `github/cloudformation-deploy-role-for-actions` / `terraform-state-backend-for-actions`

### 2.6 Executing the cut

Per deleted integration:

1. `git rm -r integrations/<id>/`
2. Delete its tests, or the describe blocks covering it in the shared plan/step test files
   (`test/integrations/ec2-plan-*.test.ts`, `iam-user-plan.test.ts`, `github-plan.test.ts`
   are the big ones — they enumerate integrations explicitly).
3. `grep -rn "<id>" integrations docs README.md` and retarget every prose reference. This is
   the only real work; the code deletion is trivial. Point references at the shared step
   factory or at the composition, not at a folder that no longer exists.
4. Leave the shared step factory in `src/providers/` **untouched** — it is the thing worth
   keeping and other integrations use it.

`bun test && bun run typecheck` must be green after each tier, not just at the end.

**Do not** delete these as one commit. One commit per tier, so a revert is cheap if a cut
turns out to be wrong.

---

## 3. Build the one integration that is missing

`docs/plan/aws-github.md` §7 `self-hosted-runner-registration` is the only planned Phase 2
task not built, and it is the one that would make the surviving EC2 folders coherent. It
scores on all four rubric criteria: multi-step, cross-system (EC2 + IAM + GitHub),
ordering-sensitive, and functionally verifiable (the runner appears online in GitHub).

The plan deliberately left one decision open. **Resolve it:**

> `aws/ec2/launch-instance/params.ts` has no `UserData` and no IAM instance-profile field.
> Extend the existing integration's params (making `launchStep` reusable), or duplicate the
> launch logic locally?

**Recommendation: extend `launchStep`** with optional `USER_DATA` and
`IAM_INSTANCE_PROFILE_ARN`. It keeps one launch path, and if Tier 3 later deletes the
`launch-instance` *integration*, the *step* stays in `src/providers/` where it belongs — the
same pattern as every other shared factory.

Two constraints from the plan worth restating because they are easy to get wrong:

- Use the **JIT-config** flow (`POST .../actions/runners/generate-jitconfig`), not the legacy
  registration-token endpoint.
- **Never call `generate-jitconfig` from `check()`.** It is mutating and single-use. `check()`
  lists runners and matches on `RUNNER_NAME`.

---

## 4. Close the Phase 3 prerequisite

Phase 3's emitter reads `Step.handoff` out of the per-run registry. Current coverage:

- **67 of 84** `resource()` declarations under `integrations/` are in files with no `handoff`.
- Only 7 integration folders declare it; the shared factories (`s3.ts`, `iam.ts` ×4,
  `github/repos.ts`) cover the rest transitively.
- `docs/handover.md` §8: the `terraform.address` values written so far *"are guesses at
  sensible module addresses… They have never been fed to Terraform. Treat them as
  placeholders."*

**Do this after §1 and §2, in that order, deliberately:**

- After §2, because backfilling `handoff` on integrations you are about to delete is wasted
  work. The prune shrinks the surface by roughly half.
- After §1, because the live runs are what tell you the real import identifiers. A
  `terraform.address` guessed from a desk is exactly the placeholder the handover warned
  about; one written while looking at a real ARN is not.

**Exit criterion:** every surviving `resource()` declaration has `handoff` metadata, and at
least one emitted `import` block has been fed to a real `terraform plan` and accepted.

---

## 5. Housekeeping carried from Phase 1

Small, assigned to Phase 2, not done. Do them in one commit.

- **Delete `src/core/ensure.ts` and `test/core/ensure.test.ts`.** Handover §5: unused in
  production, superseded by the engine's `check()`/`create()` split, and it "invites someone
  to 'helpfully' start using it and bypass the engine's rollback bookkeeping."
- **Rewrite `README.md`.** It still says `main` is *"two concrete Bun scripts"* and *"not yet
  the broader integration framework described in the roadmap."* It is 82 integrations stale
  and is the first thing anyone reads.
- **Resolve `docs/completeIntegration.md`.** Handover §10 Q2, still open: three files cite a
  deleted document as the source of the canonical tested artifacts. "Copied verbatim from a
  proven setup" is only as good as the document it points at. After §1, the live-run record
  in `docs/live-runs.md` is the natural new referent.
- **Deal with the live credential sitting in `output/` — today, not with the rest of this
  phase.** `output/testing-script-backend-username-2026-07-27.md:21` contains a **plaintext,
  unmasked `AWS_SECRET_ACCESS_KEY`** from the pre-Phase-1 script. Confirmed containment: the
  file is untracked, `output/` is gitignored, the value appears nowhere in git history
  (`git log --all -S` on the literal returns nothing), and the file is `0600`. So this is a
  local-disk exposure only, not a published one. Still: **deactivate that key in IAM and
  delete the file.** Then decide the retention story from Handover §10 Q5 — reports are
  `0600` and gitignored but accumulate, and nothing cleans them up. This is exactly the
  failure the current `report.ts` `mask()` exists to prevent; the artifact predates it.

---

## Order of work, and why

```
§1 prove the spine        <- gates everything; without it nothing else is trustworthy
§5 housekeeping           <- cheap, do it while waiting on scratch-account access
§2 cut the tail           <- shrinks the surface before you invest in it
§3 runner registration    <- the one missing integration, needs §2's launchStep decision
§4 backfill handoff       <- needs §1's real identifiers and §2's smaller surface
   -> Phase 3
```

The single most important sequencing claim: **§4 must come after §1 and §2.** Building the
handoff metadata against 82 integrations, from a desk, with placeholder Terraform addresses,
is doing Phase 3's prerequisite twice.

## Done when

1. Ten live runs recorded in `docs/live-runs.md`, all passing.
2. Catalogue at ~43, every survivor scoring 2+ on the §2.1 rubric.
3. `self-hosted-runner-registration` built and live-run.
4. Every surviving `resource()` has `handoff`, and one emitted import block accepted by a
   real `terraform plan`.
5. `README.md` describes what the repo actually is.
6. Roadmap's scope line amended per §0, so the lifecycle integrations are in scope by
   statement rather than by exception.
