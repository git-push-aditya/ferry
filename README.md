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
> script runs a `SELECT 1` self-check on connect. If bun's node-compat trips it
> up, the fallback is to keep bun for package management + `setup:backend`, and run
> `setup:integration` under Node. Whichever path was chosen is documented here by
> the setup script author.

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
bun run setup:backend              # creates user + prints the access key ONCE
```

### Flags

- `--dry-run` (both) — validate + print the plan, change nothing.
- `--write-env` (`setup:backend`) — also append the generated key to
  `./.env.backend` (`chmod 0600`). Otherwise the key is only printed.

> The generated secret access key is shown **once**, stdout only, never logged. If
> you lose it, delete the key in IAM and re-run to mint a new one.

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

## Bucket ownership (decide for zap-prod)

By default `setup:integration` **creates** the bucket (matching the tested
runbook). If your prod bucket is provisioned by Terraform / a platform team, flip
step 3 to **assert-exists-and-fail-if-missing** so the script doesn't fight your
IaC. This is the one place to consciously choose before a prod run.

---

## Troubleshooting

- **Test COPY fails with Access Denied on first run.** Expected occasionally — IAM
  trust-policy changes take a few seconds to propagate. The script retries with
  backoff; if it still fails, re-check the role's trust policy carries Snowflake's
  `STORAGE_AWS_IAM_USER_ARN` and the `sts:ExternalId` condition (both from
  `DESC INTEGRATION`).
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
