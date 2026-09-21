# Ferry

Ferry is a safety-first infrastructure bootstrap framework for setup work that is tedious, order-sensitive, and hard to verify by inspection alone.

It started with one Snowflake-to-S3 workflow. Ferry now runs **82 integrations across AWS, Snowflake, and GitHub** through one shared engine:

| Provider | Integrations | Current coverage |
| --- | ---: | --- |
| AWS | 47 | S3, IAM roles and users, EC2, ECR, Secrets Manager, SSM |
| Snowflake | 17 | Access, warehouses, S3 storage and Snowpipe, key pairs, external functions |
| GitHub | 18 | Repositories, Actions, OIDC, secrets, environments, webhooks, deploy keys, branch protection |

Every integration is a folder. The engine discovers it automatically, plans the full run before changing anything, applies only the required steps, verifies the result, and rolls back changes from the current run if something fails.

## Why Ferry exists

At an internship, we needed to process large CSV files and store them in S3. Generating them in the backend would have added compute cost and complexity, while Snowflake could unload query results directly to S3.

The setup was the hard part. The Snowflake-to-S3 path had circular dependencies and sensitive IAM configuration, and doing it manually took about 30 minutes of concentrated work each time. A script made the process repeatable. That workflow was adopted across two products and two engineering teams.

Ferry expands that idea: turn fragile infrastructure runbooks into reusable, self-verifying integrations without pretending to be a long-term state manager.

## Safety model

Ferry's guarantees live in the engine rather than in individual scripts.

### Plan before apply

Every step runs its read-only `check()` first. Ferry builds the entire plan before the first mutation. If it finds a conflict, such as an S3 bucket name owned by another account, it stops before changing anything.

### Idempotent by default

A step reports `missing`, `exists`, or `conflict`. Existing resources are skipped or explicitly reconciled instead of recreated blindly.

### Verify the outcome

After apply, each integration runs its own functional verification. Ferry does not equate "the API call returned successfully" with "the integration works."

### Roll back only this run

A change is added to the rollback stack only after Ferry creates or reconciles it. On an apply or verification failure, Ferry unwinds those changes in reverse order. Resources that were merely found and reused are not deleted.

### Keep credentials separate

Provider credentials live in the repository-root `.env`. Resource parameters live in the chosen integration's `.env`. An integration folder cannot override root credential keys.

### Keep secrets out of reports

Run reports are written to `output/` with `0600` permissions. Secret-derived values are masked. A newly created secret may be shown once when an integration requires it, but it is not written into the report.

## How it works

```text
root credentials + integration parameters
                    |
                    v
             discover integration
                    |
                    v
       plan -> apply -> verify -> report
                  |
                  +---- failure ----> rollback (LIFO)
```

An integration owns:

- a validated parameter schema
- an ordered list of provider steps
- live verification logic
- a masked Markdown report
- optional Terraform and Ansible handoff metadata

The core engine owns:

- environment loading and validation
- provider client creation and identity checks
- plan construction and conflict handling
- apply and reconcile behavior
- cascading rollback, including signal-aware cleanup
- the per-run resource ledger
- report writing

Provider clients are injected into the engine. `src/core/` does not depend on AWS, Snowflake, or GitHub implementation details.

## Quick start

### Prerequisites

- [Bun](https://bun.sh/)
- credentials for the provider or providers used by the integration
- enough provider permissions to inspect, create, update, verify, and, when needed, roll back the requested resources

Clone and install:

```bash
git clone https://github.com/git-push-aditya/ferry.git
cd ferry
bun install
```

### 1. Configure provider credentials

```bash
cp .env.example .env
```

Fill only the credential blocks needed by the integration you plan to run. Ferry currently supports root credential blocks for AWS, Snowflake, and GitHub.

Do not commit `.env`.

### 2. Configure one integration

Each integration has its own `.env.example`. Copy it beside the manifest and fill in the resource parameters:

```bash
cp integrations/aws/s3/create-bucket/.env.example \
  integrations/aws/s3/create-bucket/.env
```

Integration `.env` files contain parameters, not credentials, and should not be committed.

### 3. Inspect the available integrations

```bash
bun run ferry
```

The current entry point prints the discovered integration IDs when no ID is supplied. It is intentionally a small runner, not the full Phase 4 CLI.

### 4. Dry-run first

```bash
bun run ferry -- aws/s3/create-bucket --dry-run
```

A dry-run performs real read-only checks and credential validation, then prints what Ferry would create, reconcile, skip, or reject. It does not call any step's mutation method.

### 5. Apply and verify

```bash
bun run ferry -- aws/s3/create-bucket
```

On success, Ferry verifies the integration and writes a masked report under `output/`.

Convenience scripts for the original workflows are also available:

```bash
bun run setup:integration -- --dry-run
bun run setup:backend -- --dry-run
bun run setup:bucket -- --dry-run
```

Remove `--dry-run` only after reviewing the plan and the integration source.

## Integration library

The 82 current integration manifests are discovered from `integrations/**/integration.ts`. There is no central integration registry to update.

<details>
<summary><strong>AWS - 47 integrations</strong></summary>

### S3

- Create a bucket
- Create a least-privilege backend S3 user
- Delete an empty bucket
- Delete a bucket after download or transfer
- Sync bucket contents
- Enable lifecycle rules and logging
- Update encryption, permissions, region, versioning, and tags

### IAM roles

- Create and delete roles
- Create inline policies
- Attach, detach, and rotate permissions
- Update trust policies
- Create service-linked roles
- Tag and audit unused roles

### IAM users

- Create, delete, and offboard users
- Add or remove group membership
- Attach and detach policies
- Create, rotate, and deactivate access keys
- Enforce MFA and tag users

### EC2 and related services

- Launch, stop, start, terminate, and tag instances
- Change instance types
- Create AMIs and EBS snapshots
- Attach, detach, and resize EBS volumes
- Assign Elastic IPs
- Create and update security groups
- ECR, Secrets Manager, and SSM support used by cross-provider workflows

</details>

<details>
<summary><strong>Snowflake - 17 integrations</strong></summary>

- Create roles and warehouses
- Grant and revoke role and database/schema access
- Onboard, offboard, update, and audit users
- Add and rotate user key pairs
- Create a Snowflake-to-S3 storage integration
- Configure Snowpipe auto-ingest
- Connect an external function to Lambda
- Sync Snowflake key pairs through AWS Secrets Manager

</details>

<details>
<summary><strong>GitHub - 18 integrations</strong></summary>

- Create and delete repositories
- Add or remove collaborators
- Create environments, webhooks, and deploy keys
- Manage repository, organization, and environment secrets
- Update branch protection
- Enable, disable, and dispatch workflows
- Configure GitHub Actions OIDC roles
- Configure ECR push access, CloudFormation deployment, and Terraform state backends for Actions
- Sync AWS Secrets Manager values to GitHub secrets

</details>

## Repository layout

```text
bin/ferry.ts          Minimal integration runner: <integration-id> [--dry-run]
integrations/         82 self-contained integration folders
src/core/             Provider-neutral engine and contracts
src/providers/        AWS, Snowflake, and GitHub clients and shared steps
src/handoff/          Phase 3 emitter boundary; emitters are not implemented yet
test/                 Core, provider, and integration tests
docs/                 Roadmap, plans, architecture notes, and handover context
output/               Local masked run reports; gitignored and mode 0600
```

## Adding an integration

Create a new folder under `integrations/<provider>/<name>/` with:

```text
integration.ts   Manifest, ordered steps, verification, and report
params.ts        Validated resource parameters
steps/           Provider operations for the workflow
verify.ts        Functional proof of the result
.env.example     Parameter template with no credentials
```

The manifest ID must match its path under `integrations/`. Discovery walks the filesystem, so adding the folder is enough. If two integrations need the same provider operation, move that operation into `src/providers/` rather than copying it.

New integrations should preserve these boundaries:

- `check()` is read-only
- `create()` handles missing resources
- `reconcile()` changes an existing resource and captures what rollback needs
- `rollback()` undoes only a change made by the current run
- `verify()` proves the end-to-end outcome
- reports and resource metadata never contain secrets

## Tests

```bash
bun test
bun run typecheck
```

The tree contains **759 `test()` declarations across 39 test files**, covering the engine, discovery, environment separation, rollback, reporting, provider helpers, shared step factories, and integration behavior.

## Roadmap

### Phase 1 - shared engine

Implemented:

- folder-per-integration discovery
- provider-neutral plan, apply, verify, and rollback engine
- injected provider clients
- validated credential and parameter layers
- masked reporting and a per-run resource ledger

### Phase 2 - integration library

Implemented:

- 82 integrations across AWS, Snowflake, and GitHub
- shared provider step factories extracted from repeated workflows
- cross-provider cases, including GitHub Actions OIDC and Snowflake/AWS workflows

Next:

- run and document the live acceptance matrix against real scratch resources

### Phase 3 - Terraform and Ansible handoff

Groundwork exists, but the emitters do not.

Steps can already attach handoff metadata, and the engine records created and reconciled resources in a per-run ledger. The next work is to turn that ledger into:

- valid, reviewable Terraform `import` blocks, with no integration-specific emitter logic
- a smaller Ansible `group_vars`-shaped YAML handoff for downstream playbooks

Ferry should bootstrap and verify. Terraform or Ansible should own long-term lifecycle management. Ferry should not add its own state file.

### Phase 4 - CLI and MCP

Planned as two thin adapters over the same engine:

- CLI verbs: `plan`, `apply`, `verify`, `handoff`, `init`, `list`, and `doctor`
- MCP tools generated from integration metadata
- dry-run by default for agent use
- an explicit confirmation gate before mutation
- credentials kept server-side and out of model-visible tool parameters

The current `bin/ferry.ts` accepts an integration ID and `--dry-run`; it is deliberately not the finished CLI.

## Scope

Ferry is for genesis bootstrap work: dependency cycles, sensitive initial configuration, and live proof that the result works.

Ferry is not:

- a Terraform replacement
- a long-term desired-state manager
- a drift-remediation service
- a secret store
- a reason to skip reviewing infrastructure code before running it

Read the source before granting it infrastructure permissions. Ferry's trust story is that the load-bearing behavior is typed, local, and inspectable.

## Project status

Ferry is being built in public. The immediate sequence is:

1. run and publish the live acceptance matrix
2. keep this README aligned with the code
3. implement the Terraform handoff, followed by the Ansible handoff
4. build the full CLI verbs and credential onboarding
5. expose the same engine through MCP with dry-run and confirmation safety

Repository: https://github.com/git-push-aditya/ferry
