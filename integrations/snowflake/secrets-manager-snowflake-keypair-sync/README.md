# `snowflake/secrets-manager-snowflake-keypair-sync`

Generates a fresh RSA key pair for an existing Snowflake user and pushes
the private half into AWS Secrets Manager — a machine-to-machine
credential nobody has to hand-generate and copy-paste.

```bash
bun run bin/ferry.ts snowflake/secrets-manager-snowflake-keypair-sync --dry-run
bun run bin/ferry.ts snowflake/secrets-manager-snowflake-keypair-sync
```

## ⚠️ Security note — read before using this in production

**This is the only integration in this codebase that generates private-key
material.** `snowflake/rotate-user-key-pair` (already built) deliberately
**never** touches a private key — its own `mint-new-key` step only ever
receives an already-generated public half from the caller, and
`github/create-deploy-key`'s docs take the same stance ("private key
generation, if needed, happens outside this integration's scope"). This
integration departs from that established pattern because the entire
point of a Secrets-Manager-backed service credential is that nobody has
to hand-generate and copy-paste it — full automation requires generating
the key pair somewhere, and this integration is where that happens.

The private key exists only in local process memory for the duration of
the `sync-credential` step's `create()` call. It is never written to
`ctx.outputs`, `resource()`, or any log line — enforced by a test
(`test/integrations/secrets-manager-snowflake-keypair-sync-steps.test.ts`)
that asserts the serialized step output never contains the generated key.

**A more conservative alternative** would keep key generation as a manual
or externally-tooled step — matching `rotate-user-key-pair`'s existing
stance exactly — and have this integration only handle pushing an
already-generated key into Secrets Manager, at the cost of not being a
true one-shot bootstrap for this use case. If your threat model prefers
that, don't use this integration as-is; compose your own key generation
with a smaller "push this exact value to Secrets Manager" step instead.

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | — | opens the Snowflake connection |
| `user-exists` | (guard) confirms `SF_USER_NAME` already exists | conflict if it doesn't |
| `sync-credential` | a new key pair set on the user + pushed to Secrets Manager | create-or-skip, keyed on Snowflake's own fingerprint |
| `verify` | confirms the secret's tag matches the live fingerprint | — |

## What it needs

**Root `.env`** — `credentials: ["aws", "snowflake"]`.

**This folder's `.env`** — see `.env.example`: `SF_USER_NAME`,
`AWS_SECRET_NAME`, `FORCE_ROTATE`.

## Gotchas

**Idempotency direction is reversed from `github/sync-secrets-manager-to-
github-secrets`.** That task tags the *AWS-side* secret with an
AWS-native `VersionId`, since AWS is the source of truth there. Here
**Snowflake is the source of truth** and exposes no version number — so
the AWS secret is tagged with Snowflake's own `DESC USER`
`RSA_PUBLIC_KEY_FP` value, **read back from Snowflake after every
key-set**, never computed independently. This avoids needing to reproduce
Snowflake's exact fingerprint algorithm, which was an unnecessary risk in
an earlier draft of this integration's design.

**Targets key slot 1 directly, not the two-slot rotation dance.** This
integration is provisioning a credential for a service user, not rotating
a live one out from under active connections — if zero-downtime rotation
is later needed for this same user, `rotate-user-key-pair` composes on
top of this integration's output (it already handles the two-slot dance
generically), not the other way around.

**Rollback only removes the sync tag — it never unsets the Snowflake-side
key and never touches the AWS secret's value.** A real consumer may
already be using the new credential by the time something later in the
run fails and triggers rollback; undoing the credential itself would
break that consumer, a materially worse outcome than a stale tag.

**`check()` never reads the AWS secret's value or the Snowflake private
key** — only metadata (a tag comparison) and `DESC USER`'s fingerprint
field, both real reads with no secret-value exposure.
