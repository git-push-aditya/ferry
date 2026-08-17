# Ferry — Handover

Written at the end of **Phase 1**. Audience: whoever picks up Phase 2, human or agent.

This is not a tutorial (see the root `README.md` for how to run things) and not a spec
(see `ferry-phased-roadmap.md` for where this is going). It is the set of things that
are true about the codebase, the decisions behind them, and the traps — including the
ones I walked into.

---

## 1. Where the project stands

**Phase 1 is done.** The two standalone provisioning scripts are gone; in their place is
a shared engine plus a folder-per-integration model, with the two original scripts as
the first two integrations. Adding an integration is creating a folder — there is no
central registry, import list, or switch statement to touch.

| | |
| --- | --- |
| Branch | `restructure-integration-framework` (pushed to `origin`) |
| Commit | `ca6f9fe` "Restructure into an extensible integration framework" |
| Not yet merged | `main` is still at `80bbb1b` |
| Tests | 135 passing, 207 assertions, 13 files |
| Typecheck | clean (`bun run typecheck`) |
| Size | core 945 lines, providers 698, integrations 1419, tests 1915 |

Phase 1's "done when" from the roadmap was two conditions. The first — adding an
integration requires only a folder — is met and covered by a test
(`test/core/discover.test.ts`). The second — the ported integrations pass their existing
behaviour **including the live verification** — is **not confirmed**. See section 6.

### Uncommitted working-tree changes

At handover there are three uncommitted edits, none of them mine:

- `docs/completeIntegration.md` deleted.
- Two comment-only tweaks in `integrations/aws/s3/create-backend-s3-user/integration.ts` and
  `integrations/snowflake/create-storage-s3-integration/steps/trust-policy.ts`.

**Action needed:** three files still cite `docs/completeIntegration.md` as the source of
the canonical tested artifacts — `README.md` and both `policies/index.ts` headers. If that
file is going away for good, those references need to point somewhere real, because the
"these permissions are copied verbatim from a proven setup" claim is only as good as the
document it points at. Losing the pointer quietly turns a verifiable claim into folklore.

---

## 2. The shape of the thing

```
bin/ferry.ts          placeholder entry point: one integration id + --dry-run, nothing else
src/core/             the engine and its contracts. Knows nothing about AWS/S3/Snowflake.
src/providers/        aws/ and snowflake/: credential schemas, clients, shared helpers
src/handoff/          empty on purpose (Phase 3). See its README.
integrations/<p>/<n>/ one self-contained folder per integration
```

### The engine, in one paragraph

`runIntegration()` in `src/core/engine.ts`: load and validate the two env layers, build
provider clients, resolve identity once, then run **every** step's `check()` before any
mutation happens (the plan phase). Any `conflict` aborts there. `--dry-run` returns after
the plan. Otherwise the apply phase runs `create()` on steps that reported `missing` and
`reconcile()` on the rest, registering rollback only for steps that actually ran, then
calls `integration.verify()`. A throw anywhere in apply or verify unwinds LIFO. On
success the stack is disarmed and the report is written. Provider teardown happens in a
`finally`, after rollback, because rollback needs a live Snowflake connection to `DROP`
things.

### The contracts you must understand before writing an integration

`src/core/define.ts` is 130 lines and worth reading in full. The load-bearing parts:

**`StepState` is three-valued.** `missing` / `exists` / `conflict`. `conflict` means "the
resource is there but is not usable by this run". Returning a `conflict` instead of
throwing is what moves an unwinnable run into the plan phase, before anything is mutated.
The canonical case is an S3 bucket name owned by a different AWS account, which returns
403, not 404.

**`check()` is read-only and shallow.** Presence and ownership, nothing more. It is
explicitly *not* drift detection. If you find yourself comparing field-by-field inside a
`check()`, you are building the converge loop the roadmap says ferry is not.

**`create()` and `reconcile()` are both optional; the engine picks one.** `create()` runs
only when `check()` said `missing`. `reconcile()` runs whenever `create()` did not — which
covers both "it already exists and I am re-pointing it" and "this step has no create at
all because it only ever mutates something pre-existing". See `plannedAction()` in
`engine.ts`, which is exported and unit-tested precisely because this is the rule people
will get wrong.

**A `reconcile()` must capture the prior value in its outputs.** The engine will register
its `rollback()` like any other change, so the step is responsible for making that
rollback a *restore*, not a delete. Both existing reconcile steps do this — read
`steps/trust-policy.ts` and the `reconcile`/`rollback` pair in
`steps/storage-integration.ts`.

**`ctx.outputs` is one mutable object shared by the whole run.** Rollback closures capture
`ctx`, so they see the final outputs, not the outputs as of their own step. That is what
lets `trust-policy`'s rollback read the prior document it stashed earlier. It also means
output keys are a flat global namespace — prefix them (`storageRoleArn`,
`backendAccessKeyId`) rather than using bare names like `arn`.

**`handoff` is declared but unconsumed.** Phase 3 reads it. Populate it while writing the
step, when you actually know what the resource is.

### Providers are injected, not imported

`src/core/` never imports a concrete provider. A `ProviderDef` (`src/core/provider.ts`)
owns one credential kind: its slice of the root `.env`, the clients built from it, an
optional identity probe, and optional teardown. `src/providers/registry.ts` assembles
them and `bin/ferry.ts` hands the registry to the engine.

This is why `src/core/` can be grepped for `aws|s3|snowflake|iam` and only hit comments.
Keep it that way — it is the property that makes the engine reusable and it is very easy
to break with one convenient import.

Two consequences worth knowing:

- `ctx.accountId` looks AWS-specific but is populated generically: the engine takes the
  first `resolveIdentity()` that returns an `accountId`. A provider with no notion of an
  account simply omits the probe.
- The Snowflake provider has **no** `resolveIdentity`. Connecting is a step
  (`steps/connect.ts`), so it gets a plan entry and a banner — and because connecting is a
  read, it lives in `check()`, which means `--dry-run` validates Snowflake credentials for
  real rather than claiming it would.

---

## 3. The invariants, and where they actually live

The roadmap calls these the pillars. In Phase 1 they stopped being properties of two
scripts and became properties of the engine. If you change any of the following files,
you are touching a guarantee, not an implementation detail.

| Invariant | Enforced in | How it could break |
| --- | --- | --- |
| Idempotent re-run | `engine.ts` apply loop + each step's `check()` | A `check()` that always returns `missing` for something that *is* a resource |
| LIFO rollback of only what this run made | `rollback.ts`, and the single `registerRollback` call site in `engine.ts` | Registering rollback outside that call site, or before `create()` succeeded |
| Honest dry-run | `engine.ts` returns after the plan | A `check()` that mutates |
| Live verification | `integration.verify()`, called inside the apply try block | A verify that cannot fail |
| Fail-fast env | `env.ts` `loadEnvLayers` / `parseOrExit` | Validating one layer at a time (see below) |
| Masked reports | `report.ts` `mask()`, and each `report()` | Putting a secret in a `resource()` attribute, which lands in the registry |
| No state file | absence | Any file written outside `output/` |

Two subtleties that cost me a fix each:

**Both env layers are validated before either is allowed to fail.** My first pass
validated credentials, then params, which meant an empty environment reported only the
credential keys and you had to run twice to see the rest. The original scripts listed
everything at once and that behaviour is load-bearing — it is the cheapest failure mode
the tool has. `loadEnvLayers` now `safeParse`s both and merges the issues.
`test/core/env.test.ts` pins it ("lists offending keys from BOTH layers in one pass").

**Rollback registration has exactly one call site.** In `engine.ts`, immediately after
`create()`/`reconcile()` returns. Not before. Not in a step. A step that was skipped
created nothing, and rolling back something that already existed is the one thing this
tool must never do. If you need per-step rollback nuance, put the conditional *inside*
that step's `rollback()` (as `storage-integration` does, branching on
`storageIntegrationCreatedThisRun`), not in the engine.

---

## 4. Decisions worth knowing about

These are the calls where I chose something and the reasoning matters more than the code.
Phase 2 may well overturn some of them; do it deliberately.

### The two behaviour changes from the original scripts

**A user that already holds an access key is left alone.** The old
`setup-backend-s3-user.ts` minted a new key on every run until it hit the AWS two-key
limit, then hard-failed. That is not idempotent, and idempotency is invariant #1. So
`steps/access-key.ts` returns `exists` when the user has any key. Rotation is now an
explicit act: delete the old key in IAM, re-run.

This has a real cost, and I want it on the record rather than buried: **on a skipped-key
run there is no identity to exercise, so the live verification cannot run.** The fallback
in `verify.ts` asserts the attached policy document still matches artifact H byte for byte
and says plainly, in both the log and the report, that the end-to-end path was not
re-proven. That is a genuine partial weakening of invariant #4, accepted because the
alternative weakens invariant #1 and scatters live credentials. If Phase 2 finds a better
answer — a short-lived key minted and destroyed purely for verification, say — this is the
first place to revisit.

**The generated secret prints to stdout once and to no file.** The old script wrote the
`AWS_SECRET_ACCESS_KEY` into the `output/` report and had a `--write-env` flag that also
wrote it to `.env.backend`. Both contradict invariant #6. The report now carries the
masked value; `--write-env` is gone.

Awkward detail: the single stdout print happens inside
`integrations/aws/s3/create-backend-s3-user/integration.ts`'s `report()`, because the engine calls
`report()` exactly once, after the run is known good. It makes `report()` mildly
side-effecting, which is a trap for future integrations. If a third integration ever needs
to surface a secret, promote this to a proper engine concern (an `announce()` hook, or
returning secrets from `report()` for the engine to print) rather than copying the pattern.

### Deviations from the Phase 1 brief

- **`Step.create` is optional.** The brief had it required with `reconcile` as an add-on.
  But a trust-policy patch has no meaningful create, and a connection check has neither
  create nor reconcile, so requiring `create` would have meant dead code in two of ten
  steps. The engine guards that exactly one applies.
- **`src/providers/aws/errors.ts` exists.** The brief kept `errors.ts` in core. But
  `describeAwsError` contains the string "pick a different EXPORT_S3_BUCKET", which is
  S3-specific code in a directory that is supposed to contain none. Core now holds only
  `FerryError`; the AWS error vocabulary moved to the provider. `bin/ferry.ts` imports it
  directly, which is fine — the entry point is the composition root and already builds
  the registry.
- **`test/providers/` was added** alongside `test/core/` and `test/integrations/`. The
  migrated Snowflake-client and AWS-error tests are not core concerns.
- **`setStepTotal(steps.length + 2)`**: the two extras are verify and report. Env-load and
  plan print as uncounted `section()` headings so the "STEP n/total" numbering still lines
  up with the manifest.

### Cosmetic conventions

No emoji anywhere in the repo except the sign-off line at the bottom of `README.md`. The
logger uses ASCII tags (`OK` / `WARN` / `ERROR`) rather than glyphs, because this output
gets piped into CI logs and pasted into tickets. Arrows (`->`, `<->`) in comments are
punctuation and were left alone.

---

## 5. Dead code and loose ends

**`src/core/ensure.ts` is unused in production.** The `ensure(label, existsFn, createFn)`
create-or-skip contract was the heart of the old scripts, and the Phase 1 brief said to
preserve it. But the engine's `check()`/`create()`/rollback-registration split *is* that
contract, generalised — so `ensure()` now has no caller outside its own migrated test.

I kept it rather than delete it because the brief said not to weaken a migrated test to
make a refactor easier, and deleting the function deletes the test. **Phase 2 should
delete both.** It is the one piece of the codebase that exists for historical rather than
functional reasons, and leaving it invites someone to "helpfully" start using it and
bypass the engine's rollback bookkeeping.

**`docs/completeIntegration.md` references.** Covered in section 1.

---

## 6. What is NOT verified

This is the most important section in the document. Do not let it get lost.

**The live acceptance checks have never been run against real infrastructure.** The AWS
credentials in the local root `.env` are expired STS session tokens (`ASIA...` prefix with
a session token), so every attempt failed at `STS GetCallerIdentity` with
`InvalidClientTokenId`. That is the *first* real API call the engine makes, which means
everything past it is unexercised in production.

Specifically unproven:

1. Clean-account provision of `snowflake/create-storage-s3-integration`, including the
   `COPY INTO` verification actually landing a CSV.
2. Immediate re-run being a genuine no-op that exits 0.
3. Ctrl-C mid-run rolling back only this run's resources, LIFO.
4. `aws/s3/create-backend-s3-user` running standalone against a bucket it did not create.
5. The real IAM propagation timings still being adequate. The waits were carried over
   verbatim, but the trust-policy patch now runs as a `reconcile` in a different position
   relative to the other steps, so the timing profile is not identical to the old script's.

What *is* proven, deterministically, with stub providers driving the **real** manifests
(`test/integrations/plan.test.ts`):

- Both integrations' full step order and plan actions on a clean account.
- Dry-run issues zero mutating AWS commands and zero mutating SQL.
- An already-provisioned account plans no creates.
- A 403 bucket aborts in the plan phase with zero mutating calls, for both integrations.
- The backend integration builds no Snowflake client at all.

And in `test/integrations/reconcile-steps.test.ts`: the DESC parse and its failure mode,
the trust-policy prior-document restore (including the role-already-deleted case), the
storage-integration create-vs-reconcile branch and its two rollback paths, and the
access-key `check()` states.

So the *logic* is well covered and the *live path* is not covered at all. Refresh the
credentials and run the five checks above before treating Phase 1 as closed. Two of them
(3 and 4) need a scratch AWS account or at least a scratch bucket name, since they
deliberately create and destroy things.

---

## 7. Starting Phase 2

The roadmap's Phase 2 is a deep, real use-case library: go deep on AWS and Snowflake
first, then add one deliberately different provider (GitHub OIDC role bootstrap is the
named candidate) to prove the abstraction holds outside its origin.

### Mechanically, adding an integration

Create `integrations/<provider>/<name>/` with `integration.ts` default-exporting
`defineIntegration({ id: "<provider>/<name>", ... })`. The id must equal the folder path;
discovery fails loudly if not. Copy the shape of an existing folder — `params.ts`,
`steps/`, `verify.ts`, `.env.example`, `README.md`.

Reusable pieces already in `src/providers/`: `s3BucketStep`, `s3PrefixMarkerStep`,
`policyState`/`roleState`/`userState`, the ARN builders, `ensureBucketState`,
`listKeys`/`deleteKeys`/`emptyAndDeleteBucket`, `s3BucketName`/`s3Prefix`/
`snowflakeIdentifier` param refinements, `showsExactly`/`descProperties`.

Anything two integrations both need belongs in `src/providers/`, not duplicated in
folders. The bucket step is the worked example: both integrations need it, neither owns
it, so it lives in the provider and reuse registers no rollback.

### Where the abstraction will be stressed first

Honest prediction of what the third integration breaks, so it is not a surprise:

1. **A provider whose credentials are not a static key pair.** GitHub OIDC is
   token-shaped and possibly interactive. `ProviderDef.createClients` is documented as
   "must not perform I/O", which will need revisiting — probably by making it async or by
   pushing the exchange into `resolveIdentity`.
2. **Cross-provider ordering.** Both current integrations happen to need AWS first,
   Snowflake second. Nothing enforces or expresses inter-provider ordering; steps are a
   flat list and the author gets it right by writing them in order. That has held for two
   integrations and will not hold forever. Resist adding a dependency graph until a real
   integration actually needs one — a flat ordered list that everyone understands beats a
   DAG nobody does.
3. **Steps that create N things.** Every current step maps to exactly one resource, which
   is what makes `resource()` and rollback clean. A step that creates a variable number of
   things (N bucket notifications, N grants) has no home in the current model. The likely
   answer is a step *factory* that expands into N steps at manifest-build time, keeping
   one-step-one-resource intact. Do that rather than making `resource()` return an array.
4. **A verify that needs to clean up after itself on the failure path.** The storage
   integration's verify handles this with a `finally` that sweeps the test object whether
   or not confirmation succeeded, because `verify()` has no access to the rollback stack.
   That worked for two integrations. If it gets repetitive, giving `verify()` a scoped
   rollback registrar is the natural fix.
5. **Propagation waits.** Currently per-integration (`waits.ts`), which is right — the
   timings are properties of the resources involved, not of the engine. But there is now
   near-duplicate retry-with-backoff logic in both `verify.ts` files. Third occurrence,
   promote it to `src/core/wait.ts` as a `retryWithBackoff(predicate, backoffs)` alongside
   `pollUntil`. Not before.

### A discipline worth keeping

The roadmap says three excellent, genuinely-tested integrations beat ten written but never
run. Phase 1 ends with a concrete illustration of why: a fully green 135-test suite and a
live path that has never executed once. Tests prove the logic; only a real run proves the
integration. Both matter, and they are not substitutes.

---

## 8. Readiness for Phases 3 and 4

**Phase 3 (Terraform/Ansible handoff)** has its inputs in place and no emitter, which is
what the roadmap asked for. `Step.handoff` is declared in `define.ts` and populated on
every resource-bearing step in both integrations. `src/core/registry.ts` records, per step
that actually created or reconciled something: step id, title, action, the `ResourceRef`
(type, logical name, identifying attributes), and the resolved handoff metadata. The
engine returns it as `RunResult.registry`.

Two things Phase 3 should check before writing the emitter:

- The `terraform.address` values I wrote are guesses at sensible module addresses
  (`aws_iam_role.snowflake_storage`, etc.). They have never been fed to Terraform. Treat
  them as placeholders.
- Steps that declare no `resource()` are deliberately excluded from the ledger — the
  `desc-integration` read changes nothing there is to hand off. If Phase 3 wants those
  entries for provenance, that is a one-line engine change, but think about whether a
  ledger of "things that changed" should contain things that did not.

**Phase 4 (CLI and MCP)** gets more from the engine than it might look:

- `RunResult` already carries `plan`, `registry`, `outputs`, and `reportPath` — the plan
  phase is separately observable, which is exactly what a `plan` verb and an MCP dry-run
  need.
- `runIntegration` takes `credentialSource` and `folderEnvPath` overrides, so an adapter
  can supply credentials from a provider chain instead of a `.env` without touching the
  engine.
- `discoverIntegrations` gives a `list` verb for free, and each integration's `summary`
  is already written as a one-line description suitable for an MCP tool description.

What Phase 4 will have to add: `runIntegration` currently prints directly via
`src/core/logger.ts` module-level functions. An MCP server needs structured events, not
stdout. The `Logger` interface in `logger.ts` exists and is already what steps receive via
`ctx.log` — the fix is to make the engine take a `Logger` too instead of importing the
module-level writers. Small change, better done deliberately in Phase 4 than patched in
under pressure.

Also relevant to MCP's safety story: the signal-handler path calls `process.exit(130)`
after rollback, so provider teardown does not run. Fine for a CLI. An in-process MCP
server cannot use `process.exit` at all.

---

## 9. Traps

Short list of things that look like improvements and are not.

- **Do not import a provider into `src/core/`.** One convenient import undoes the whole
  separation. Grep is the test: `grep -rniE "aws|s3|snowflake|iam" src/core/*.ts` should
  hit comments only.
- **Do not reorder the storage integration's steps.** `iam-role` (placeholder trust) →
  `storage-integration` → `desc-integration` → `trust-policy` encodes a circular
  dependency. There are ordering comments in `steps/trust-policy.ts` and
  `steps/iam-role.ts` saying so. Believe them.
- **Never `CREATE OR REPLACE STORAGE INTEGRATION`.** It regenerates the external id and
  silently invalidates the IAM trust policy built around the old one. The failure surfaces
  much later as an unrelated-looking Access Denied. A test pins the `IF NOT EXISTS` +
  `ALTER ... SET` form.
- **Do not let `check()` grow into drift detection.** It is the single easiest way to turn
  ferry into the lifecycle tool the roadmap says it is not.
- **Do not add a state file.** Not a cache, not a "last run" marker, not a lockfile. Live
  state is re-read every run; that is the whole trust model.
- **Do not attempt a create on an S3 403.** `ensureBucketState` returns `conflict` and the
  plan aborts. A 403 means either another account owns the name or the credentials cannot
  read a bucket you do own — neither is fixed by creating.
- **Do not use `ensure()` from `src/core/ensure.ts`.** It bypasses the engine's rollback
  bookkeeping. Delete it instead (section 5).
- **Watch what goes into `resource()` attributes.** They land in the registry and,
  eventually, in emitted Terraform. `steps/access-key.ts` records the key id and never the
  secret, and `steps/trust-policy.ts` records that an external-id condition exists rather
  than its value. Keep that discipline.

---

## 10. Open questions for a human

Things I could not decide alone, in rough priority order.

1. **Merge `restructure-integration-framework` into `main`, or keep it open pending the
   live acceptance run?** My inclination: run the five checks in section 6 first, then
   fast-forward. It is a 78-file change and the live path is unexercised.
2. **Where do the canonical tested artifacts live now that `docs/completeIntegration.md`
   is being deleted?** Three files cite it. The "copied verbatim from a proven setup"
   guarantee needs a real referent.
3. **Is the skipped-key verification fallback acceptable, or should the backend
   integration mint a throwaway key purely to verify?** Section 4 has the trade-off.
4. **Which providers for Phase 2, concretely?** The roadmap names GitHub OIDC as the
   deliberately-different one and says go deep on AWS and Snowflake first. Choosing the
   specific AWS and Snowflake cases is a product call about who the audience is, not an
   engineering one.
5. **Does `output/` need a retention or scrubbing story?** Concretely: should Ferry delete
   old local reports after some age ("retention"), or at least tell the user to remove
   older pre-Phase-1 reports that still contain an unmasked secret access key
   ("scrubbing")? Current reports are 0600 and gitignored, but they accumulate. Nothing
   reads them; nothing cleans them up either.
