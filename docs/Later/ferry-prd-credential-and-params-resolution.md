# Ferry — PRD: Credential & Params Resolution

## Status

Supersedes the "root `.env` for credentials" design in the T1 restructure prompt. The layered
loader concept survives; the "credentials live in a root `.env`" part is replaced by native
provider-chain resolution. Apply this before running T1, or as an immediate follow-up.

## Problem

The current design (and the first T1 draft) asks the user to place AWS and Snowflake credentials
into a `.env` file. Two problems:

1. **Friction.** Populating a `.env` with the full AWS + Snowflake credential set is the messiest
   part of onboarding. Copy `.env.example`, look up each value, paste, hope the format is right.
2. **Bad security posture.** It nudges users toward long-lived static access keys sitting in a
   file on disk — the exact posture Ferry would otherwise be well-placed to discourage. It also
   ignores that most engineers on the target profile *already* have working cloud credentials
   configured locally (AWS CLI, SSO, Snowflake `connections.toml`).

The tool should ask for credentials as close to *never* as possible, and resolve them the way the
surrounding ecosystem already does.

## Principles

- **Never prompt for, accept as a flag, or store a raw credential.** Credentials resolve through
  provider chains; Ferry holds a client, not a secret.
- **Zero setup for anyone already configured.** If `aws sts get-caller-identity` works in their
  shell and they can open a Snowflake connection from `snowsql`, Ferry should need no credential
  input at all.
- **Params are not credentials.** Resource names and toggles are project config — safe to write
  down, safe to commit to a private infra repo. They get a first-class, low-friction input path.
- **This holds identically for CLI and MCP.** The engine receives a *credential provider* and a
  *validated params object*. It never sees a secret string, and neither surface can inject one.

---

## Part A — Credential resolution

### A.1 AWS

Use the AWS SDK v3 default provider chain rather than reading keys yourself.

- Resolve via `fromNodeProviderChain()` (from `@aws-sdk/credential-providers`). This already
  covers, in order: env vars (`AWS_ACCESS_KEY_ID` etc.), the shared config/credentials files
  (`~/.aws/*`), named profiles, SSO sessions, web-identity tokens, and container/instance roles.
- Add a `--profile <name>` CLI flag. When present, resolve with `fromIni({ profile })` (or set
  `AWS_PROFILE` for the chain). When absent, the default chain runs.
- Region resolution: `--region` flag > `AWS_REGION`/`AWS_DEFAULT_REGION` > profile's configured
  region. If none resolve, fail fast with a clear message naming all three options.
- Do **not** define an `AWS_SECRET_ACCESS_KEY` field in any Ferry schema. If it's in the
  environment, the chain finds it; Ferry never names it.

**Outcome:** an engineer using AWS SSO (short-lived creds, the good posture) works with zero
Ferry config. An engineer with `~/.aws/credentials` works with zero Ferry config. CI with env
vars works with zero Ferry config.

### A.2 Snowflake

Mirror Snowflake's own tooling conventions.

- Read the standard `connections.toml` (default `~/.snowflake/connections.toml`, overridable via
  `SNOWFLAKE_HOME`). Honor a `--connection <name>` flag selecting a named connection; fall back
  to the `default_connection_name` if set.
- Support key-pair auth and externalbrowser/SSO auth as first-class, not just password — key-pair
  is the service-account norm and SSO is the human norm. Preserve the existing rule requiring
  *some* valid auth method and failing fast if none resolves.
- Env-var overrides (`SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USER`, etc.) remain honored for CI, layered
  *below* an explicit `--connection`.
- The connection's role/warehouse/database/schema come from the connection definition; a Ferry
  integration may still require specific ones and should validate their presence, but should not
  ask the user to re-type them if the connection already carries them.

### A.3 `.env` as fallback only

- A root `.env` remains *supported* but is explicitly the fallback path, documented as "for CI or
  environments with nothing configured," not the happy path.
- It may supply the same env vars the provider chains already read (`AWS_*`, `SNOWFLAKE_*`). It
  does not introduce Ferry-specific credential key names.
- Loading order for credentials: explicit flags (`--profile`, `--connection`, `--region`) >
  ambient environment / native config files > root `.env`. First hit wins.

### A.4 Engine contract

- The engine is constructed with a **credential provider**, not credential values: an object
  exposing `awsCredentials()` and `snowflakeConnectionConfig()` that resolve lazily on first use.
- An integration declares `credentials: ["aws"]` / `["aws","snowflake"]`; the engine only invokes
  the resolvers it declared, so an AWS-only integration never triggers Snowflake resolution and
  never fails for lack of a Snowflake connection.
- `doctor` command: resolves every declared credential, runs a read-only identity check
  (STS `GetCallerIdentity`; Snowflake `SELECT CURRENT_ACCOUNT()`), and reports what resolved from
  where — **without printing any secret**. This is the "is my environment set up" preflight.

---

## Part B — Params resolution

### B.1 Where params live

- Per-integration folder `.env` holds params only — resource names, target names, toggles. Never
  secrets. Gitignored in this repo; users may commit their own copy to their private infra repo.
- Params are never inherited from root or from another integration. Each folder is standalone;
  duplicating a bucket name across two folders is intentional.

### B.2 `ferry init <integration>` — the friction fix

Replace "copy `.env.example` and edit it blind" with a guided writer driven by the integration's
existing zod schema.

- Iterate the integration's `params` schema. For each field, prompt with: the field name, a
  one-line description, the validation rule (surfaced from the zod refinement, e.g. "letters,
  digits, underscore; no leading digit"), and a default if the schema defines one.
- Validate each answer against the schema *at input time*; reprompt on failure with the specific
  reason, so the user never writes an invalid file and discovers it at apply time.
- Write the folder `.env` at the end. If one exists, diff and confirm before overwriting; never
  silently clobber.
- `--non-interactive` mode: accept `KEY=value` pairs / read from flags, validate, write — for
  scripted setup and for the MCP path.

### B.3 Params in the engine

- Params load from the folder `.env` (or `init`-written file), validate against the schema, and
  fail fast listing *every* invalid/missing field at once (preserve current `fail()` behavior).
- Precedence: CLI flags (`--bucket=...`) > folder `.env` > schema default. MCP tool params occupy
  the same slot as CLI flags.
- The engine receives the validated params object only. No raw file parsing downstream of the
  loader.

---

## Part C — MCP alignment

- Credentials are **server-side only**, resolved by the same provider chain. They are never tool
  parameters. An LLM-visible credential field is a prompt-injection target aimed at the exact
  thing being protected — structurally forbidden, not just discouraged.
- Params *are* tool parameters, validated against the same zod schema (schema is the single
  source of truth for CLI prompts, `.env` validation, and MCP input validation alike).
- `doctor` maps naturally to a read-only MCP tool (`readOnlyHint: true`) an agent can call to
  check the environment before attempting a provisioning tool.

---

## Changes to the T1 prompt

- Replace the "Root `.env` — credentials only" section with Part A of this document:
  provider-chain resolution, `.env` demoted to fallback.
- Keep the folder-`.env`-for-params design; add `ferry init` (B.2) and `doctor` (A.4) to the CLI
  verb set — but note these are the *only* CLI additions permitted in T1; the broader CLI build
  remains its own later task.
- Update acceptance criteria:
  - [ ] With AWS SSO / `~/.aws` configured and a Snowflake `connections.toml` present, a clean run
        needs no credential input of any kind
  - [ ] No Ferry schema anywhere defines a raw secret field (`AWS_SECRET_ACCESS_KEY`,
        `SNOWFLAKE_PASSWORD`, private-key material)
  - [ ] `ferry doctor` reports resolved identities for all declared credentials, printing no secret
  - [ ] `ferry init snowflake/create-storage-s3-integration` writes a valid folder `.env` via schema-driven
        prompts, reprompting on invalid input
  - [ ] `--profile` / `--connection` / `--region` flags override ambient resolution as specified
  - [ ] An AWS-only integration never triggers Snowflake resolution and never fails for a missing
        Snowflake connection

## Explicitly out of scope

- No credential storage, caching, or writing by Ferry, ever.
- No secret-manager integrations in this PRD (a future integration *target*, not part of resolution).
- No publishing/binary/installer work — unrelated (see the CLI architecture-vs-distribution note).
- No broader CLI surface beyond `init` and `doctor` here; the full verb set is its own task.
