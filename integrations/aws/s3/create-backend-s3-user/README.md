# `aws/s3/create-backend-s3-user`

Gives a backend service its own least-privilege AWS credentials for the export
bucket, and proves the policy actually permits the work — and nothing broader.

```bash
bun run setup:backend -- --dry-run
bun run setup:backend
```

Shares no IAM object with any other integration. The only resource this may
reuse is the bucket, which this integration does not own.

## What it creates

| Step | Resource | Artifact |
| --- | --- | --- |
| `s3-bucket` | S3 bucket (**shared** — see below) | — |
| `iam-policy` | IAM policy: `ListBucket` on the bucket, `Get`/`Put`/`DeleteObject` on its objects | H |
| `iam-user` | IAM user, programmatic access only (no console login profile) | — |
| `attach-policy` | policy → user attachment | — |
| `access-key` | access key pair | — |
| `verify` | writes, reads, lists and deletes an object **as the new user**, and confirms `s3:ListAllMyBuckets` is denied | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only. It never asks for Snowflake
credentials.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `EXPORT_S3_BUCKET` | bare name, no `s3://`, no trailing slash |
| `EXPORT_S3_PREFIX` | must end with `/`; used for the verification object |
| `BACKEND_IAM_USER_NAME` | plain AWS name |
| `BACKEND_IAM_POLICY_NAME` | plain AWS name |

`EXPORT_S3_BUCKET` is declared in this folder on purpose. Each integration keeps
its own params so the folder stands alone, and this one may point at a bucket
some other team provisioned.

## Reuses vs creates

- **Bucket — reused if it exists, and this is the common case.** The step lives in
  `src/providers/aws/s3.ts`; this integration does **not** own the bucket. If it
  already exists and belongs to your account it is reused and **no rollback is
  registered for it**, so a failed run will never delete a bucket it found. If the
  name is owned by a different AWS account the run aborts in the plan phase, before
  any mutation.
- **Policy / user / attachment — created if missing, skipped if present.** An
  attachment already in place is never detached on rollback.
- **Access key — created only if the user holds none.**

## Gotchas

**A re-run mints no second key.** If the user already has an access key, the step
is skipped. Creating a key on every run would burn through the two-key AWS limit
and scatter live credentials nobody asked for. To rotate: delete the old key in
IAM, then re-run.

**The full secret is printed once, to stdout, and not written to any file.**
The report under `output/` carries the masked value only. Ferry does keep a
local report with resource identifiers and masked values, so treat `output/` as
sensitive local metadata. If you lose the full secret, delete the key in IAM
and re-run.

**Verification degrades honestly on a skipped key.** With no key minted this run
there is no identity to exercise, so `verify()` instead asserts the attached
policy document still matches artifact H byte for byte, and says plainly in both
the log and the report that the live path was not re-proven.

**Object access is bucket-wide, not prefix-scoped.** Artifact H grants
`arn:aws:s3:::<bucket>/*`, matching the tested setup. `EXPORT_S3_PREFIX` is used
for the verification object, not to narrow the policy. Narrowing it here would
diverge from the artifact this was copied from — change the artifact if you want
that.

**The verify includes a negative control.** It calls `s3:ListAllMyBuckets`, which
artifact H deliberately does not grant, and fails the run if it *succeeds* —
that would mean the user carries permissions from somewhere else (another policy,
a group membership) and is broader than it looks.

**New credentials need a moment.** A fresh access key and a fresh policy
attachment both read as denied for a few seconds, so the first call through the
new identity retries with backoff (`InvalidAccessKeyId`, `SignatureDoesNotMatch`,
and assume-role-style denials only — a genuine permission error is not retried
forever).

**`--write-env` is gone.** The old script could append the pair to
`./.env.backend`. Writing a live secret to a file is exactly what guarantee 6
forbids, so the secret now prints once instead. Copy it into your secret store.
