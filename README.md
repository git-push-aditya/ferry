# Ferry

Ferry is a security-sensitive bootstrap tool for tedious, ordering-sensitive
infrastructure setup work. On the current `main` branch, Ferry is still a
focused codebase with **two concrete Bun scripts** for one Snowflake-to-S3 use
case, plus shared libraries and tests. It is **not** yet the broader
integration framework described in the roadmap.

The current repository automates:

- creating and verifying a Snowflake storage integration that can write CSV
  exports to S3
- creating a separate least-privilege IAM user for a backend service to access
  the same bucket

The project already enforces the properties Ferry is meant to keep as it grows:
idempotent setup, fail-fast execution, rollback of resources created by the
current run, live verification, and masked reporting to local files instead of
printing secrets.

## Current Status

Today, `main` contains:

- `scripts/setup-snowflake-s3-integration.ts`
  Creates the S3 bucket/prefix, IAM policy, IAM role, Snowflake storage
  integration, Snowflake stage, and then runs a live `COPY INTO` verification.
- `scripts/setup-backend-s3-user.ts`
  Creates a least-privilege IAM user and access key for backend access to the
  same bucket.
- `scripts/lib/*`
  Shared logic for environment validation, AWS and Snowflake clients, rollback,
  polling, report writing, policy generation, and error handling.
- `test/lib/*`
  Bun tests covering the shared library behavior.
- `docs/completeIntegration.md`
  The original manual runbook/reference for the Snowflake/S3 setup.
- `docs/ferry-phased-roadmap.md`
  The forward plan for evolving Ferry beyond these two scripts.

That means Ferry already has the core safety and verification behavior, but it
has **not yet** been refactored into the folder-per-integration engine/CLI/MCP
shape planned for later phases.

## What The Repo Does Right Now

| Script | Command | Current behavior |
| --- | --- | --- |
| Snowflake/S3 integration | `bun run setup:integration` | Provisions the Snowflake-to-S3 path end-to-end and verifies it by writing a test CSV through Snowflake into S3. |
| Backend S3 user | `bun run setup:backend` | Provisions a least-privilege IAM user and generates a fresh access key for backend use. |

Both scripts support `--dry-run`. The backend script also supports
`--write-env`, which writes the generated runtime credentials to `./.env.backend`
with `0600` permissions.

## Repo Layout

```text
scripts/
  setup-snowflake-s3-integration.ts
  setup-backend-s3-user.ts
  lib/
test/
  lib/
docs/
  completeIntegration.md
  ferry-phased-roadmap.md
```

## Prerequisites

- `bun`
- AWS credentials with enough IAM and S3 access to perform the requested setup
- Snowflake credentials with enough privilege to create the storage integration
  and stage for the integration flow

Install dependencies:

```bash
bun install
```

## Configuration

Use the example environment file as the starting point:

```bash
cp .env.example .env
```

The scripts validate required environment variables at startup and exit before
making API calls if required values are missing or invalid.

Notable validation rules:

- `EXPORT_S3_BUCKET` must be a bare bucket name
- `EXPORT_S3_PREFIX` must end with `/`
- `SF_STORAGE_INTEGRATION_NAME` and `SF_STAGE_NAME` must be valid unquoted
  Snowflake identifiers
- the integration flow requires either `SNOWFLAKE_PASSWORD` or
  `SNOWFLAKE_PRIVATE_KEY`

## Running The Current Scripts

Dry-run first:

```bash
bun run setup:integration -- --dry-run
bun run setup:backend -- --dry-run
```

Apply:

```bash
bun run setup:integration
bun run setup:backend
```

Optional backend credential file output:

```bash
bun run setup:backend -- --write-env
```

## Safety Guarantees In The Current Code

- **Idempotent behavior**
  Existing resources are detected and reused where appropriate.
- **Rollback on failure**
  Each run only tears down resources it created itself, in reverse dependency
  order.
- **Signal-aware cleanup**
  `SIGINT` and `SIGTERM` trigger the same rollback path.
- **Live verification**
  The Snowflake integration flow finishes with a real `COPY INTO` test and
  confirms the object lands in S3.
- **Sensitive output handling**
  Reports are written to local files with `0600` permissions instead of printing
  secrets to stdout.

## Tests

Run the current automated test suite with:

```bash
bun test
```

The tests focus on the shared library behavior: environment validation,
rollback, error formatting, policy generation, report writing, polling, and
Snowflake helper logic.

## What’s Coming Soon

The current repo is the starting point. The near-term plan in
`docs/ferry-phased-roadmap.md` is:

- **Phase 2: deeper integration library**
  Expand beyond the initial Snowflake/S3 setup into a small number of real,
  high-value bootstrap integrations, staying deep rather than broad.
- **Phase 3: Terraform and Ansible handoff**
  After a successful verified run, emit handoff artifacts so long-lived tools
  can take over lifecycle management cleanly.
- **Phase 4: CLI and MCP surfaces**
  Put a consistent CLI and agent-facing MCP layer on top of the shared engine,
  with dry-run and confirmation-first safety.

Those phases are planned work, not current repository behavior on `main`.
