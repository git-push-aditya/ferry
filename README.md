# ferry

**Ferry provisions cross-cloud integrations and then proves they actually work.**

Wiring Snowflake to S3 — or any two clouds that have to trust each other — is a
long manual runbook of IAM policies, trust relationships, external IDs and stages,
where the steps depend on each other in a circle and a single wrong ordering fails
silently hours later. Ferry turns one of those runbooks into a folder you can run,
re-run, and hand to someone else.

The part that matters: ferry does not stop when the API calls return 200. Every
integration ends by running the real workload — an actual `COPY INTO` that lands a
CSV in S3, an actual write/read/delete performed as the new IAM user — and if that
fails, it tears down everything it just built and leaves your account as it found it.

---

## What problem this solves

A cross-cloud integration runbook has three properties that make it miserable by hand:

1. **The steps are circular.** The IAM role needs Snowflake's external ID; Snowflake
   won't issue one without the role ARN. So the role is created with a placeholder
   trust policy, the integration is created, its identity is read back, and only then
   is the trust policy patched. Get that order wrong and nothing tells you.
2. **It half-fails.** A step-6 failure leaves five orphaned resources behind, and the
   next attempt trips over them.
3. **"Done" is unverifiable.** Every API call succeeded, and the export still doesn't
   work, because IAM propagation or an external-ID mismatch only shows up under real
   traffic.

Ferry addresses all three: fixed step ordering encoded in code, automatic LIFO
rollback of anything a failed run created, and a live functional verification as the
last step.

## Who this is for

- **Platform, data and infrastructure engineers** who need a Snowflake-to-S3 export
  path (or a least-privilege service credential) set up correctly in a new AWS
  account or a new environment.
- **Small teams without a dedicated IaC pipeline**, who need something more
  repeatable than a wiki page but don't want to adopt Terraform for one integration.
- **Anyone doing this more than once** — a second region, a staging clone, a customer
  environment. The whole design assumes you will run it again.

You should be comfortable on a terminal and able to supply admin AWS credentials and
a Snowflake `ACCOUNTADMIN` role. You do not need to know Terraform, and you do not
need to understand the runbook ferry replaces.

## Who this is not for

- **Teams already managing these resources in Terraform or CloudFormation.** Ferry
  would fight your IaC. It is a bootstrapper, not a competitor. (A future task emits
  `import` blocks so ferry can hand resources over rather than compete for them.)
- **Anyone wanting a converge/update loop.** Ferry's job ends at "exists correctly
  and is verified working". It will not reconcile your infrastructure toward a spec
  on an ongoing basis, and it deliberately keeps no state file.
- **Deleting things.** Ferry only removes what a failing run of its own created.
  There is no teardown command.

---

## What ships today

| Integration | Command | What it does |
| --- | --- | --- |
| `snowflake/s3-storage-integration` | `bun run setup:integration` | S3 bucket + prefix, IAM policy + role + Snowflake trust policy, storage integration + external stage, and a live `COPY INTO` that verifies a CSV actually lands in S3. |
| `aws/s3-backend-access` | `bun run setup:backend` | A least-privilege IAM user + access key, verified by a real write/read/delete performed as that user. |

They share no IAM object. The only overlap is the S3 bucket, and neither integration
owns it.

---

## The seven things ferry guarantees

These are why the tool is trusted. Every integration inherits them from the engine.

1. **Idempotent.** Re-running against a completed setup is a no-op that exits 0.
2. **Cascading cleanup.** Any failure, throw, or Ctrl-C unwinds everything created
   *this run*, in LIFO order. Anything that already existed is never touched.
3. **Honest dry-run.** `--dry-run` runs every `check()` and zero `create()`.
4. **Verified, not asserted.** "Provisioned" means a real workload succeeded, not
   that an API returned 200. A failed verify rolls the whole run back.
5. **Fail-fast env.** Zod validates before the first API call, listing *every* bad
   key at once.
6. **Masked reports.** Markdown, `chmod 0600`, written to `output/`. Secrets are
   masked; a freshly minted key prints to stdout once and to no file, ever.
7. **No state file.** Ferry re-reads live cloud state on every run. It holds no
   stored belief about what exists, so there is nothing to drift, lock, or corrupt.

---

## Layout

```
ferry/
├── bin/ferry.ts              # placeholder entry point (not a CLI yet)
├── .env                      # CREDENTIALS ONLY - gitignored
├── .env.example
├── src/
│   ├── core/                 # engine, contracts, rollback, env layering - provider-agnostic
│   ├── providers/            # aws/ and snowflake/: credentials, clients, shared helpers
│   └── handoff/              # empty: Terraform/Ansible emitters are a later task
├── integrations/
│   ├── snowflake/s3-storage-integration/
│   └── aws/s3-backend-access/
├── test/{core,providers,integrations}/
└── output/                   # 0600 reports - gitignored
```

`src/core/` contains nothing AWS-, S3-, or Snowflake-specific. The engine is handed a
**provider registry** from outside (`src/providers/registry.ts`), so core never
imports a concrete provider.

---

## Folder-per-integration

An integration folder is the single source of truth for one integration:

```
integrations/snowflake/s3-storage-integration/
├── integration.ts     # the manifest: params, credential kinds, steps, verify, report
├── params.ts          # zod schema for this folder's .env
├── steps/             # one file per step
├── policies/          # the IAM/trust policy documents this integration owns
├── verify.ts          # the live proof
├── waits.ts           # this integration's propagation timings
├── .env               # params - gitignored
├── .env.example       # committed, complete
└── README.md
```

The manifest is just data:

```ts
export default defineIntegration<Params>({
  id: "snowflake/s3-storage-integration",
  schemaVersion: 1,
  summary: "...",
  params: paramsSchema,          // folder .env, no credentials
  credentials: ["aws", "snowflake"],
  steps: [ /* ordered */ ],
  verify,                        // throws -> full rollback
  report,                        // markdown, secrets masked
});
```

Each step is a small object the engine drives:

```ts
{
  id, title,
  check(ctx):     Promise<"missing" | "exists" | "conflict">,  // read-only
  create?(ctx):   Promise<Outputs>,   // only when check() said "missing"
  reconcile?(ctx):Promise<Outputs>,   // for mutating something that already exists
  rollback(ctx):  Promise<void>,      // registered only if create/reconcile ran
  resource?(ctx), handoff?,           // for the run ledger and the future IaC handoff
}
```

`check()` is a **shallow presence/ownership probe**, deliberately. Ferry's job ends at
"exists correctly and is verified working" - it is not a converge loop and does no
field-by-field drift detection.

---

## Two env layers, strictly separated

| | Root `.env` | Integration folder `.env` |
| --- | --- | --- |
| Holds | credentials only | params only (resource names, toggles) |
| Shared? | yes, by every integration | no, never inherited |
| Example | `AWS_SECRET_ACCESS_KEY`, `SNOWFLAKE_ROLE` | `EXPORT_S3_BUCKET`, `SF_STAGE_NAME` |

The rules the engine enforces:

- A folder `.env` that sets **any** credential key is a hard error, naming the key and
  the file. A checked-out folder must never be able to redirect a run at another AWS
  account or Snowflake instance.
- Params are **never** inherited from the root layer. Both integrations declare
  `EXPORT_S3_BUCKET` in their own `.env`; the duplication is the point, because a
  folder has to stand alone.
- An integration only supplies the credential kinds it declares.
  `aws/s3-backend-access` declares `["aws"]`, so it never asks for Snowflake.
- Both `.env` files are gitignored; both `.env.example` files are committed and
  complete.

---

## Setup

```bash
bun install
cp .env.example .env                                     # credentials
cp integrations/snowflake/s3-storage-integration/.env.example \
   integrations/snowflake/s3-storage-integration/.env     # params
cp integrations/aws/s3-backend-access/.env.example \
   integrations/aws/s3-backend-access/.env                # params
```

Prerequisites:

- **bun** (`curl -fsSL https://bun.sh/install | bash`). It runs the `.ts` files
  directly and auto-loads the root `.env` - no build step, no `tsx`, no `dotenv`.
- An **AWS identity** that can create/attach policies, create/update roles and trust
  policies, create users, and create S3 buckets.
- A **Snowflake role** that can `CREATE INTEGRATION` - in practice `ACCOUNTADMIN`
  (only for `snowflake/s3-storage-integration`).

> **snowflake-sdk under bun:** `snowflake-sdk` is a Node driver. The
> `snowflake-connect` step runs a `SELECT 1` self-check on connect. Verified: it
> connects and executes queries cleanly under bun 1.3 - no Node fallback needed.

### Two kinds of credentials - do not mix them up

- **Admin bootstrap creds** (root `.env`) - used to *run* ferry. They exist only to
  provision.
- **Runtime creds** - the access key `aws/s3-backend-access` *generates*. This is the
  least-privilege key your application uses.

Never ship the admin creds into your app; never widen the runtime user.

---

## Run

```bash
bun run setup:integration -- --dry-run   # plan only, changes nothing
bun run setup:integration                # provision + verify

bun run setup:backend -- --dry-run
bun run setup:backend

bun run ferry                            # lists the integrations it found
bun run ferry aws/s3-backend-access
```

`--dry-run` is the only flag. `bin/ferry.ts` is a **placeholder**, not a CLI: real
subcommands, a scaffolder, and the Terraform/Ansible handoff are later tasks.

### What you'll see

```
── Load + validate environment ──
  OK    Environment valid (root credentials + integrations/.../.env)
  aws: provisioning as arn:aws:iam::...:user/admin (account 9093...)

── Plan ──
  [create   ] Ensure S3 bucket
  [skip     ] Ensure IAM policy (artifact A)
  [reconcile] Patch role trust policy with Snowflake identity (artifact C)
  ...

── STEP 1/12: Ensure S3 bucket ──
  OK    s3-bucket: created
  ...
── STEP 11/12: Verify ──
  OK    Verification passed
── STEP 12/12: Report ──
  OK    Report written to output/...-2026-08-09.md (chmod 0600)
```

Any `conflict` in the plan aborts the run **before the first mutation**, listing what
conflicted. The commonest cause is an S3 bucket name owned by a different AWS account.

### Reports

Written to `output/<name>-<date>.md`, `chmod 0600`, gitignored. Treat `output/` like
`.env`. The backend integration's generated secret is **masked** in the report and
printed to stdout exactly once, at the end of the run that created it.

---

## Adding an integration

Create a folder. That's the whole procedure - there is no central registry, import
list, or switch statement to touch. Discovery globs `integrations/**/integration.ts`
and derives the id from the folder path.

```
integrations/<provider>/<name>/
├── integration.ts        # default-export defineIntegration({ id: "<provider>/<name>", ... })
├── params.ts
├── steps/
├── verify.ts
├── .env.example
└── README.md
```

Then:

1. **Declare credential kinds**, don't invent them. `credentials: ["aws"]` makes the
   engine load and validate the AWS slice of the root `.env` and build the clients. A
   genuinely new kind means adding a `ProviderDef` under `src/providers/` and
   registering it in `src/providers/registry.ts` - that is a provider change, not an
   integration change.
2. **Put params in your folder's `.env.example`**, complete, with the same refinements
   the real thing needs (`s3BucketName`, `s3Prefix`, `snowflakeIdentifier` are all
   reusable).
3. **Reuse shared resources from providers.** Anything two integrations both need -
   the bucket, for instance - belongs in `src/providers/`, not in one folder.
   `s3BucketStep` is there for exactly this.
4. **Make `check()` honest.** Return `"conflict"`, not an exception, when the resource
   exists but isn't usable, so the abort happens in the plan phase.
5. **Write a real `verify()`.** If it can't fail, it isn't verification.
6. **Populate `handoff`** while the resource is fresh in your mind. Nothing consumes
   it yet; a later task will.

`id` must equal the folder path - discovery fails loudly if they disagree.

---

## Rollback

Every resource a run **actually creates** registers an undo action; if any later step
or the verify throws, the run unwinds them in reverse (LIFO) order before exiting
non-zero.

Reverse order matters because AWS refuses to delete a resource that still has
dependents - an access key before its user, a policy detached before its role is
deleted, the Snowflake stage before the storage integration it depends on.

- **Only what this run created is undone.** Pre-existing resources are detected in the
  plan phase (including whether a policy attachment was already in place) and left
  completely alone.
- **`reconcile` steps restore, not delete.** A step that patches something that already
  existed (an IAM trust policy, a re-pointed storage integration) captures the prior
  value first and puts it back on rollback.
- **Ctrl-C rolls back too.** `SIGINT`/`SIGTERM` trigger the same unwind, so
  interrupting during a propagation wait doesn't strand resources.
- **Cleanup is best-effort and never silent.** One failing undo doesn't stop the rest,
  and the run prints an explicit `Rollback incomplete - manually check: ...`.
- **A successful run is never torn down.** The stack is disarmed before the report.
- **Provider teardown happens after rollback**, so Snowflake `DROP`s still have a live
  connection.

---

## IAM propagation waits

IAM is eventually consistent: a freshly created role/policy - or a trust policy that
was just patched - isn't reliably usable by other AWS services for a few seconds.
Rather than guess a fixed sleep, ferry polls a read-your-write check until confirmed,
then adds a short fixed buffer:

| After | Confirms via | Poll | Buffer |
| --- | --- | --- | --- |
| Creating the IAM policy/role | `GetPolicy` / `GetRole` succeed | up to 20s | 15s |
| Patching the role trust policy | `GetRole` read-back actually contains Snowflake's IAM user ARN + external id | up to 30s | 20s |
| Minting a backend access key | first `PutObject` through the new identity | - | retry/backoff |

Both waits are **skipped entirely** when nothing was newly created, so a re-run against
an already-correct account stays fast. Expect a first-time run to spend roughly 35-60s
here. A poll that times out warns and proceeds rather than failing - the verify's own
retry/backoff is the final safety net.

---

## The permissions are copied from a proven setup

Every IAM policy, trust policy, and SQL statement is reproduced **verbatim** from the
tested staging integration (see `docs/completeIntegration.md`); only literal names are
swapped for params. The policy builders live in each integration's `policies/` folder
and are pinned by tests that compare them field for field. If a permission looks wrong,
change it in the canonical artifacts - not in the generated code - so the "tested"
guarantee stays intact.

---

## Troubleshooting

- **Plan says `conflict` on the bucket.** The name is taken by another AWS account
  (bucket names are globally unique), or the bootstrap creds lack
  `s3:ListBucket`/`s3:GetBucketLocation` on a bucket you do own. Ferry will never
  attempt a create on a 403.
- **`COPY` fails with Access Denied on the first run.** Expected occasionally. Ferry
  waits for the trust-policy read-back and then retries with backoff; if it still
  fails, re-check the role's trust policy carries Snowflake's
  `STORAGE_AWS_IAM_USER_ARN` and the `sts:ExternalId` condition (both from
  `DESC INTEGRATION`).
- **A run failed - do I clean anything up?** Normally no. Only if the output ends with
  `Rollback incomplete - manually check: ...`.
- **Snowflake "insufficient privileges to operate on account".** Your `SNOWFLAKE_ROLE`
  can't create integrations - use `ACCOUNTADMIN`.
- **`InvalidClientTokenId` before the plan.** Your root `.env` AWS credentials have
  expired (common with `ASIA...` session credentials).
- **I need a new backend access key.** Delete the old one in IAM, then re-run. Ferry
  will not mint a second key on a user that already has one - that's idempotency, not
  a bug.

---

## Development

```bash
bun test          # 135 tests
bun run typecheck
```

Tests are split `test/core/` (engine, rollback, env layering, discovery),
`test/providers/` (the three-way bucket ownership branch, Snowflake client), and
`test/integrations/` (the canonical policy artifacts, both real manifests driven
through a stubbed plan phase, and the reconcile/restore paths).

---

made with ❤️ by Aditya for community
