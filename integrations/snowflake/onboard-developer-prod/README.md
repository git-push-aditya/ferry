# `snowflake/onboard-developer-prod`

Onboards a new developer into the **PRODUCTION** Snowflake account: creates
their user with key-pair-only auth (no password) and grants their default
role.

```bash
bun run setup:integration -- --dry-run
bun run setup:integration
```

## This is a distinct-approval-path action — read before running

Granting a developer prod access is, in most orgs, subject to a distinct
approval/review process from staging onboarding — a different reviewer, a
ticket, a change-management sign-off, whatever your org requires. **Ferry
itself has no built-in approval gate** — it has no concept of "pending
approval" or "reviewer sign-off" to encode, only mechanical resource
creation. This integration performs the mechanical Snowflake object
creation (`CREATE USER` + `GRANT ROLE`) and nothing else.

**Whoever runs this integration is expected to have already gone through
their org's real prod-access approval process out of band, before running
this command.** Running this integration is the *execution* step, not the
approval step. If your org's process requires a ticket number or approver
name in the audit trail, capture that outside Ferry (e.g. in the ticket
itself, or a wrapper script around this command) — this integration's
`report()` output only documents what was mechanically created, not who
approved it.

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | nothing — opens the shared connection and self-checks it | |
| `onboard-developer` | Snowflake `USER` + role grant | `CREATE USER` with `RSA_PUBLIC_KEY` set, no password, then `GRANT ROLE ... TO USER` |
| `verify` | nothing — live read confirming the user exists and holds the role | |

This is mechanically identical to `../onboard-developer-staging` — same
step logic, same SQL, same rollback semantics. The only differences are this
folder's `id`, its report framing, and (critically) which Snowflake account
it actually runs against.

## What "prod" means here — IMPORTANT

**This integration does not select a Snowflake account.** Staging and
production are, per Snowflake's own recommended pattern, **separate
accounts** — each with its own account identifier/URL and its own
independent set of users, roles, and admin credentials. There is no
Ferry-level parameter (e.g. `SF_ENV=prod`) that toggles between them: that
would let one root `.env` credential set silently reach either account,
which is exactly the control point a real org wants to avoid for prod.

Instead, this codebase models the distinction as **two separate integration
folders** — `../onboard-developer-staging` and this one — both declaring
`credentials: ["snowflake"]` and running structurally identical logic. Which
actual Snowflake account gets hit is determined entirely by which root
`.env` is active (i.e. which `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USERNAME` /
key-pair or password credentials are loaded) when you run this folder's
command. **Before running this integration, make sure your repo-root
`.env` points at your PRODUCTION account and holds credentials scoped for
prod** — Ferry has no way to verify that for you, and running this against
the wrong account's `.env` will not raise an error; it will just create the
user in whatever account you pointed at.

This separate-folder structure also gives your org a hard control point:
this folder's root `.env` and whoever is authorized to run it can require a
different reviewer/credential set than staging's — something a single
parameterized integration could not enforce.

## What it needs

**Root `.env`** — `credentials: ["snowflake"]`. `SNOWFLAKE_ROLE` needs
`CREATE USER` and `GRANT ROLE` privileges (in practice an admin-equivalent
role) against the **production** account — very likely a distinct
credential set (account identifier, username, key-pair) from staging's.

**This folder's `.env`** — see `.env.example`:

| Param | Notes |
| --- | --- |
| `USER_NAME` | Snowflake identifier: letters/digits/underscore, no leading digit, no hyphen |
| `EMAIL` | developer's email |
| `PUBLIC_KEY` | RSA public key, PEM or bare base64 body — either is accepted |
| `DEFAULT_ROLE` | must already exist in the PROD account (this task does not create roles) |

## Reuses vs creates

- **User — created if missing, left alone if it already exists.** This
  integration does not diff or update an already-onboarded user's role or
  key — that is `update-user-role` / `rotate-user-key-pair` /
  `add-public-key-to-existing-user`'s job, run separately and deliberately.
- **Role — never created here.** The `DEFAULT_ROLE` must already exist; if
  it doesn't, `GRANT ROLE` fails loudly and clearly at apply time rather than
  this task silently creating a role for a developer in production.

## Gotchas

**No password is ever set.** Key-pair-only onboarding, same as staging.

**`RSA_PUBLIC_KEY` wants the base64 body only.** Either a full PEM block or
the bare base64 body is accepted; PEM wrapper lines are stripped
automatically if present.

**Rollback drops the user entirely.** `rollback()` only fires when this run
created the user, so `DROP USER IF EXISTS` is safe here — no prior history
is lost.

**Double-check your root `.env` before every run.** Because Ferry has no
built-in concept of "which environment am I pointed at," a stale or
copy-pasted staging `.env` in the wrong place is the single most likely way
this integration could accidentally run against the wrong account. Confirm
`SNOWFLAKE_ACCOUNT` before running, every time.
