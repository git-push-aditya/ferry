# `snowflake/onboard-developer-staging`

Onboards a new developer into the **staging** Snowflake account: creates
their user with key-pair-only auth (no password) and grants their default
role.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

This is the standard, low-stakes onboarding path for new developers —
staging access is not expected to require a separate approval workflow the
way granting prod access does (see `../onboard-developer-prod`'s README for
that distinction).

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | |
| `onboard-developer` | Snowflake `USER` + role grant | `CREATE USER` with `RSA_PUBLIC_KEY` set, no password, then `GRANT ROLE ... TO USER` |
| `verify` | nothing — live read confirming the user exists and holds the role | |

## What "staging" means here — IMPORTANT

**This integration does not select a Snowflake account.** Staging and
production are, per Snowflake's own recommended pattern, **separate
accounts** — each with its own account identifier/URL and its own
independent set of users, roles, and admin credentials. There is no
Ferry-level parameter (e.g. `SF_ENV=staging`) that toggles between them,
because that would not be a safe model: it would let one root `.env`
credential set silently touch either account, defeating the whole point of
having separate accounts with separate access control.

Instead, this codebase models the distinction as **two separate integration
folders** — this one (`onboard-developer-staging`) and
`onboard-developer-prod` — both declaring `credentials: ["snowflake"]` and
running structurally identical logic. Which actual Snowflake account gets
hit is determined entirely by which root `.env` is active (i.e. which
`SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USERNAME` / key-pair or password credentials
are loaded) when you run this folder's command. **Before running this
integration, make sure your repo-root `.env` points at your staging
account** — Ferry has no way to verify that for you.

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. `SNOWFLAKE_ROLE` needs
`CREATE USER` and `GRANT ROLE` privileges (in practice an admin-equivalent
role) against the **staging** account.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen |
| `EMAIL` | developer's email |
| `PUBLIC_KEY` | RSA public key, PEM or bare base64 body — either is accepted |
| `DEFAULT_ROLE` | must already exist in the staging account (this task does not create roles) |

## Reuses vs creates

- **User — created if missing, left alone if it already exists.** This
  integration does not diff or update an already-onboarded user's role or
  key — that is `update-user-role` / `rotate-user-key-pair` /
  `add-public-key-to-existing-user`'s job, run separately and deliberately.
- **Role — never created here.** The `DEFAULT_ROLE` must already exist; if
  it doesn't, `GRANT ROLE` fails loudly and clearly at apply time rather than
  this task silently creating a role for a developer.

## Gotchas

**No password is ever set.** This is a key-pair-only onboarding path,
matching the emphasis on registering a public key at onboarding time. If the
developer also needs password auth, that's a separate, deliberate action
outside this integration's scope.

**`RSA_PUBLIC_KEY` wants the base64 body only.** Snowflake's `CREATE USER`
property takes the base64 body of the public key — not the PEM
`-----BEGIN PUBLIC KEY-----` / `-----END PUBLIC KEY-----` wrapper lines. This
integration accepts either shape and strips the wrapper lines automatically
if present, so you can paste a full PEM block or just the base64 body.

**Rollback drops the user entirely.** Because this run only ever fires
`rollback()` when it was the one that created the user (a step whose
`check()` found the user already `exists` never registers rollback), `DROP
USER IF EXISTS` on rollback is safe — there is no prior history being
destroyed, since the user didn't exist before this run.
