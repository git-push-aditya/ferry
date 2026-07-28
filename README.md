# Snowflake ⇄ S3 Integration Setup

Two idempotent, fail-fast TypeScript scripts (run with **bun**) that replace the
manual cross-cloud runbook for exporting Snowflake query results to S3 as CSV
(via `COPY INTO` an external stage), and for giving the backend service its own
S3 access.

| Script | Command | What it does |
| --- | --- | --- |
| Integration | `bun run setup:integration` | S3 bucket + prefix, IAM policy + role + trust policy, Snowflake storage integration + external stage, and a **live COPY test** that verifies a CSV actually lands in S3. |
| Backend user | `bun run setup:backend` | A least-privilege IAM **user** + access key so the backend can read/write the same bucket. |

The two scripts share **no** IAM objects — the only overlap is the S3 bucket
itself. `setup:backend` never touches Snowflake.

---

## The permissions are copied from a proven setup

Every IAM policy, trust policy, and SQL statement in these scripts is reproduced
**verbatim** from the tested staging integration; only literal names (bucket,
prefix, account id, resource names) are swapped for env vars. The scripts do not
invent or adjust permissions. If a permission looks wrong to you, change it in the
prompt's *CANONICAL TESTED ARTIFACTS* section — not in the generated code — so the
"tested" guarantee stays intact.

---

## ⚠️ Two kinds of credentials — do not mix them up

- **Admin bootstrap creds** (in `.env`) — used to *run* these scripts. Need IAM
  write access and Snowflake `ACCOUNTADMIN`. They exist only to provision.
- **Runtime creds** — the access key `setup:backend` *generates*. This is the
  least-privilege key your application uses.

Never ship the admin creds into your app; never widen the runtime user.

---

## Prerequisites

- **bun** installed (`curl -fsSL https://bun.sh/install | bash`). bun runs the
  `.ts` files directly and auto-loads `.env` — there is no build step, no `tsx`,
  no `dotenv`.
- An **AWS IAM identity** that can create/attach policies, create/update roles and
  their trust policies, create users, and create S3 buckets.
- A **Snowflake role** that can `CREATE INTEGRATION` — in practice `ACCOUNTADMIN`.
- Target AWS region decided up front (bucket names are globally unique).

Install deps:

```bash
bun install
```

> **snowflake-sdk under bun:** `snowflake-sdk` is a Node driver. The integration
> script runs a `SELECT 1` self-check on connect (`scripts/lib/snowflake.ts`).
> Verified: `snowflake-sdk` connects and executes queries cleanly under bun 1.3 —
> no Node fallback is needed. Both scripts run under `bun run`.

---

## Configure

```bash
cp .env.example .env
# fill in EVERY value — the scripts refuse to run on missing/blank vars
```

Env is validated with zod at startup. Missing anything → the full list of
offending keys prints and the script exits **before any API call**.

---

## Run

Dry-run first in a new environment (validates creds, prints the plan, changes
nothing):

```bash
bun run setup:integration -- --dry-run
bun run setup:integration          # provision + verify

bun run setup:backend -- --dry-run
bun run setup:backend              # creates user + writes a report to ./output
```

### Flags

- `--dry-run` (both) — validate + print the plan, change nothing.
- `--write-env` (`setup:backend`) — also append the generated key to
  `./.env.backend` (`chmod 0600`).

### Output reports

Both scripts write a markdown report to `./output/` (created if missing,
gitignored) instead of printing secrets to stdout:

- `setup:integration` → `output/<SF_STORAGE_INTEGRATION_NAME>-<date>.md` — S3
  bucket/prefix, the IAM policy/role names + ARNs, the trust-policy principal
  and external id, and the Snowflake integration + stage names.
- `setup:backend` → `output/<BACKEND_IAM_USER_NAME>-<date>.md` — the IAM
  user/policy names + ARNs and the generated `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` pair.

Every report file is `chmod 0600`. Both contain sensitive material (an
external id and/or a live access key) — treat `./output/` like `.env`: never
commit it, and rotate the affected credential if a file ever leaks. Only the
non-secret `AWS_ACCESS_KEY_ID` is echoed to stdout for a quick sanity check;
the secret itself is written to the report only.

---

## What "verified" means

`setup:integration` finishes by running:

```sql
COPY INTO @<stage>/setup_test
  FROM (SELECT CURRENT_TIMESTAMP)
  FILE_FORMAT = (TYPE = CSV) HEADER = TRUE OVERWRITE = TRUE;
```

then confirms the object landed in S3 (from the AWS side) and cleans it up. A
green run means the whole assume-role → write path works, not just that the API
calls returned 200.

---

## Idempotency

Both scripts are safe to re-run. Existing resources are detected and skipped or
reconciled; a fully-provisioned account reports "already correct" and exits 0. The
storage integration uses `IF NOT EXISTS` + `ALTER … SET` — **never**
`CREATE OR REPLACE`, which would regenerate the external ID and silently break the
IAM trust policy.

---

## If a step fails: automatic rollback

Neither script leaves half-built infrastructure behind. Every resource a run
**actually creates** registers an undo action; if any later step throws, the run
stops immediately and unwinds them in reverse (LIFO) order before exiting
non-zero.

Reverse order matters because AWS refuses to delete a resource that still has
dependents — an access key is deleted before its user, a policy is detached
before the role it's attached to is deleted, and the Snowflake stage is dropped
before the storage integration it depends on.

**Only what this run created is undone.** Anything that already existed is
detected up front (including whether a policy attachment was already in place)
and is left completely untouched. Re-running against a partially-provisioned
account will never delete infrastructure it didn't make.

Other guarantees:

- **Ctrl-C rolls back too.** `SIGINT`/`SIGTERM` trigger the same unwind, so
  interrupting during one of the propagation waits doesn't strand resources.
- **Cleanup is best-effort and never silent.** If one undo fails, the rest are
  still attempted and the run prints an explicit
  `Rollback incomplete — manually check: …` list. Nothing is swallowed.
- **A successful run is never torn down** — the stack is disarmed once the
  report is written.
- **The two scripts share no rollback state.** A failure in one has no effect on
  the other.

---

## IAM propagation waits

IAM is eventually consistent: a freshly created role/policy — or a trust policy
that was just patched — isn't reliably usable by other AWS services for a few
seconds. Rather than guess a fixed sleep, `setup:integration` polls a
read-your-write check until it's confirmed, then adds a short fixed buffer:

| After | Confirms via | Poll | Buffer |
| --- | --- | --- | --- |
| Creating the IAM policy/role | `GetPolicy` / `GetRole` succeed | up to 20s | 15s |
| Patching the role trust policy | `GetRole` read-back actually contains Snowflake's IAM user ARN + external id | up to 30s | 20s |

Both are **skipped entirely** when nothing was newly created, so a re-run
against an already-correct account stays fast. Expect a first-time run to spend
roughly 35–60s in these waits. If a poll times out it warns and proceeds rather
than failing — the verification COPY's own retry/backoff is the final safety
net.

---

## Bucket ownership (decide for zap-prod)

By default `setup:integration` **creates** the bucket (matching the tested
runbook). If your prod bucket is provisioned by Terraform / a platform team, flip
step 3 to **assert-exists-and-fail-if-missing** so the script doesn't fight your
IaC. This is the one place to consciously choose before a prod run.

---

## Troubleshooting

- **Test COPY fails with Access Denied on first run.** Expected occasionally — IAM
  trust-policy changes take a few seconds to propagate. The script already waits
  for the trust-policy read-back (see *IAM propagation waits*) and then retries
  with backoff; if it still fails, re-check the role's trust policy carries
  Snowflake's `STORAGE_AWS_IAM_USER_ARN` and the `sts:ExternalId` condition (both
  from `DESC INTEGRATION`).
- **A run failed — do I need to clean anything up?** Normally no; the script rolls
  back everything it created (see *If a step fails: automatic rollback*). Only if
  the output ends with `Rollback incomplete — manually check: …` do you need to
  delete the named resources by hand.
- **`BucketAlreadyExists`.** Bucket names are globally unique across all AWS
  accounts — pick another `EXPORT_S3_BUCKET`. (`BucketAlreadyOwnedByYou` = success.)
- **Snowflake "insufficient privileges to operate on account".** Your
  `SNOWFLAKE_ROLE` can't create integrations — use `ACCOUNTADMIN`.
- **`CreateAccessKey` limit.** An IAM user holds at most 2 access keys — rotate/
  delete an old one first.

---

## Why the integration script interleaves AWS and Snowflake

The role's trust policy needs Snowflake's IAM user ARN + external ID, but those
don't exist until *after* the storage integration is created. So the role is first
made with a throwaway trust policy, the integration is created, its identity is
read back via `DESC INTEGRATION`, and only then is the trust policy patched to its
real value. Getting that order right is the whole reason the manual runbook was
error-prone.
# ferry
