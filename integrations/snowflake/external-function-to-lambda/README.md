# `snowflake/external-function-to-lambda`

Wires a Snowflake `EXTERNAL FUNCTION` to invoke an AWS Lambda through API
Gateway — lets SQL call out to arbitrary compute mid-query.

```bash
bun run bin/ferry.ts snowflake/external-function-to-lambda --dry-run
bun run bin/ferry.ts snowflake/external-function-to-lambda
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | — | opens the Snowflake connection |
| `api-role` | IAM role, placeholder trust policy | phase A of the two-phase dance |
| `api-integration` | Snowflake `API INTEGRATION` | create-only, `CREATE ... IF NOT EXISTS` |
| `desc-api-integration` | reads `API_AWS_IAM_USER_ARN`/`API_AWS_EXTERNAL_ID` | always runs — apply-time only |
| `trust-policy` (shared `iamTrustPolicyStep`) | patches the role to the real principal | phase B of the two-phase dance |
| `external-function` | the `EXTERNAL FUNCTION` object | create-only |
| `verify` | a live `SELECT` call through the real round trip | retries on assume-role denial (propagation lag) |

## What it needs

**Root `.env`** — `credentials: ["aws", "snowflake"]`.

**This folder's `.env`** — see `.env.example`: `SF_API_INTEGRATION_NAME`,
`AWS_API_ROLE_NAME`, `API_GATEWAY_INVOKE_URL`, `SF_EXTERNAL_FUNCTION_NAME`,
`SF_FUNCTION_ARG_TYPES`, `SF_FUNCTION_RETURNS`, `SMOKE_TEST_ARGS`.

## Gotchas

**The Lambda + API Gateway resource must already be deployed with a real,
live invoke URL before this runs.** `API_ALLOWED_PREFIXES` and the
external function's `AS` clause both need a real URL at creation time.
This integration never provisions Lambda or API Gateway itself — building
a generic "Lambda + API Gateway proxy" bootstrap is a substantially
different, more open-ended integration (arbitrary function code, arbitrary
routing), explicitly out of scope here.

**This is the two-phase placeholder-trust-policy dance's second bespoke
occurrence in this codebase**, not its third. `snowflake/create-storage-
s3-integration` has the first. `github/setup-github-actions-oidc-role`
does **not** use this pattern — its trust values are fully deterministic
from `accountId` + caller-supplied strings, needing no placeholder phase.
Per this project's own "two bespoke copies fine, a third promotes"
convention, this is not (yet) extracted into a shared factory — see
`docs/plan/aws-snowflake.md` for the reasoning, including a correction of
an earlier, over-eager promotion recommendation during that plan's own
drafting.

**`API_ALLOWED_PREFIXES` is a security boundary, not a casual setting.**
Widening it later is a real, deliberate loosening of what URLs Snowflake
is allowed to call — this integration does not warn on a widening change
today; treat any change to `API_GATEWAY_INVOKE_URL` as a reviewed decision.

**No settings-drift reconcile on the external function itself.** Changing
the argument signature or return type after creation requires dropping
and recreating it by hand — Snowflake has no `ALTER` for those fields.

**`verify()` retries on an assume-role denial specifically** — the trust-
policy patch may still be propagating even after `GetRole` confirmed it,
since STS evaluates `AssumeRole` separately. A non-propagation error (a
genuine Lambda failure, a bad payload) is not retried.
