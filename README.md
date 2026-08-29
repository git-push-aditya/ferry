# Ferry

Ferry is a security-sensitive bootstrap tool for tedious, ordering-sensitive
infrastructure setup work -- the multi-step, cross-system procedures that are
currently done by hand off a wiki page, where the steps depend on each other's
output and a failure halfway through leaves a mess.

Ferry runs one of those procedures, proves it worked by exercising it, and
tears down everything it created if any step fails.

## Status

Ferry is an **engine plus a folder-per-integration catalogue**. Adding an
integration means creating a folder; there is no central registry, import list,
or switch statement to touch.

- `src/core/` -- the engine and its contracts. Knows nothing about any
  provider: plan (`check()` every step) -> apply (`create()`/`reconcile()`) ->
  `verify()` -> LIFO rollback on any throw.
- `src/providers/` -- AWS, Snowflake and GitHub: credential schemas, clients,
  and the shared step factories integrations compose from.
- `integrations/<provider>/<name>/` -- one self-contained folder each.
- `bin/ferry.ts` -- a placeholder entry point, not yet a CLI. It understands one
  integration id and `--dry-run`.

Phase 2 completed the depth pass across AWS, Snowflake and GitHub. **Phase 2.5
(`docs/ferry-phase-2.5.md`) is in progress**: it prunes the catalogue down to
the integrations that genuinely have Ferry's shape, then runs them against live
infrastructure. The per-integration catalogue is deliberately not listed here
until that prune lands -- run `bun run ferry` with no arguments for the current
list.

### What is not yet proven

**No integration in this repository has been run against live infrastructure.**
The test suite is comprehensive (759 tests against the real integration
manifests with stubbed providers) and it proves the *logic*: step ordering, plan
actions, dry-run issuing zero mutating calls, rollback branches. It does not
prove the live path -- IAM propagation timings, eventual consistency, and real
API shapes are all unexercised. `docs/ferry-phase-2.5.md` section 1 tracks
closing this, and `docs/live-runs.md` will record it.

## The invariants

These are properties of the engine, not of individual integrations, so every
integration inherits them:

- **Idempotent re-run** -- every step's `check()` runs before any mutation. A
  re-run of a completed setup is a no-op that exits 0.
- **Rollback of only what this run created** -- LIFO, registered at exactly one
  call site in the engine, and only after a `create()`/`reconcile()` actually
  succeeded. `SIGINT`/`SIGTERM` take the same path.
- **Honest dry-run** -- `--dry-run` returns after the plan phase and issues zero
  mutating calls.
- **Live verification** -- `verify()` runs inside the apply try-block, so a
  failure there unwinds the run. The flagship case really does `COPY INTO`
  through Snowflake and confirms the object landed in S3.
- **No state file** -- not a cache, not a last-run marker. Live state is re-read
  every run; that is the whole trust model.
- **Masked reports** -- written to `output/` with `0600`, secrets masked.

## Running an integration

```bash
bun install
bun run ferry                                  # list integrations
bun run ferry <integration-id> -- --dry-run    # plan only, no mutations
bun run ferry <integration-id>                 # apply
```

## Configuration

Credentials come from the root `.env`; per-integration parameters come from a
`.env` inside the integration's own folder, with a committed `.env.example`
beside it.

```bash
cp .env.example .env
```

Both layers are validated before either is allowed to fail, so an empty
environment reports every missing key in one pass rather than one layer at a
time.

## Reports

Each successful run writes a masked report to `output/`, `0600`, gitignored.

**Nothing cleans `output/` up.** Reports accumulate, and they contain resource
identifiers. Reports written by the pre-Phase-1 scripts contained an *unmasked*
secret access key -- those have been deleted from this repo, and if you have
copies from before August 2026, delete them and rotate anything they name.
Masking (`src/core/report.ts`) has covered every run since.

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

Validation runs at startup and exits before any API call if required values are
missing or invalid.

Notable validation rules:

- `EXPORT_S3_BUCKET` must be a bare bucket name
- `EXPORT_S3_PREFIX` must end with `/`
- `SF_STORAGE_INTEGRATION_NAME` and `SF_STAGE_NAME` must be valid unquoted
  Snowflake identifiers
- the integration flow requires either `SNOWFLAKE_PASSWORD` or
  `SNOWFLAKE_PRIVATE_KEY`

## Tests

759 tests across the engine (`test/core/`), the provider helpers
(`test/providers/`), and the integrations themselves (`test/integrations/`) --
the latter driving the *real* integration manifests with stub providers, which
is what pins step order, plan actions and the dry-run guarantee.

```bash
bun test
bun run typecheck
```

## What's next

Phases 1 and 2 are done. The roadmap is `docs/ferry-phased-roadmap.md`; the
current phase is `docs/ferry-phase-2.5.md`.

- **Phase 2.5: prune and prove** (in progress)
  Cut the catalogue to the integrations that genuinely have Ferry's shape, then
  run them against live infrastructure.
- **Phase 3: Terraform and Ansible handoff**
  After a successful verified run, emit handoff artifacts so long-lived tools
  can take over lifecycle management cleanly.
- **Phase 4: CLI and MCP surfaces**
  Put a consistent CLI and agent-facing MCP layer on top of the shared engine,
  with dry-run and confirmation-first safety.
