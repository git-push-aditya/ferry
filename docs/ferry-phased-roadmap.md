# Ferry — Phased Development Roadmap

Ferry's scope is fixed: **one-shot, verified, self-cleaning bootstrap of tedious cross-system
setups** — not lifecycle management, not a state engine, not an update tool. Its pillars are
idempotency, cascading rollback to a clean slate, live functional verification, and masked
reporting. Every phase below serves that scope; nothing in the plan drifts toward "our IaC tool."

The phases are ordered by dependency, not preference. Each one is a prerequisite for the next,
and doing them out of order means building something twice.

---

## Phase 1 — Make the current setup extensible

**What:** Refactor the two existing Snowflake↔S3 scripts into a framework: a shared engine
(plan → apply → verify → rollback) and a folder-per-integration model, where each integration is
a self-contained folder discovered automatically. The two current scripts become the first two
integrations (`snowflake/s3-storage-integration`, `aws/s3-backend-access`), so Phase 1 ships with
two working use cases, not zero.

**Why it comes first:** Everything else hangs off this. The handoff mechanism reads from the
engine's registry of what-was-created; the CLI is verbs over the engine; MCP wraps the same
engine. Without the abstraction, each later phase would be re-implemented per script. This is
also where the pillars stop living inside individual scripts and become properties of the engine
that every future integration inherits for free.

**Done when:** adding an integration is creating a folder — no edits to any central registry —
and the two ported integrations pass their existing behavior including the live verification.

---

## Phase 2 — Expand to a deep, real use-case library

**What:** Go deep on a small number of *famous* providers rather than shallow across many. Cover
the major, genuinely-tedious, cross-system bootstrap cases within AWS and Snowflake first — the
providers Ferry already understands — then add one deliberately different provider (GitHub OIDC
role bootstrap is the natural candidate) to prove the abstraction holds outside its origin.

The goal is a *rooted* catalogue: for each selected provider, the well-known setup pains that
share Ferry's shape (multi-step, ordering-sensitive, credential-touching, currently done from a
wiki page). Not a race to ten shallow entries — three excellent, genuinely-tested integrations
beat ten that were written but never run against real infrastructure.

**Why it matters:** This is where Ferry earns adoption or doesn't. Depth in one niche (e.g. the
Snowflake↔S3 data-engineering audience) is a findable, winnable position; breadth-first is the
cold-start trap where the framework works but no one has heard of any single integration. Phase 2
is also the real stress test of Phase 1 — the first non-AWS/Snowflake integration is where the
engine either holds or reveals what it got wrong. Better to learn that at integration #3 than #10.

**Done when:** the selected providers have their major known cases covered by integrations that
have each been run and verified against live resources, and the engine required no per-integration
special-casing to support them.

---

## Phase 3 — Terraform & Ansible handoff

**What:** A `--handoff` flag, run only after a successful verified run, that hands the
just-created resources off to a long-lived management tool. For Terraform: emit `import` blocks
(and optionally draft HCL via `plan -generate-config-out`) from the engine's registry of what
*this run* actually created. For Ansible: emit a `group_vars`-shaped YAML fragment of resource
identifiers for downstream playbooks to consume.

**Why it matters:** This resolves the "isn't this just a worse Terraform?" question by making the
boundary explicit and cooperative — Ferry does the one thing Terraform does badly (the
bootstrap-cycle + live verification), then hands a clean, known-good state to whatever manages it
long-term. It's what keeps Ferry honestly scoped as *genesis bootstrap* rather than creeping into
lifecycle management. The Terraform path is the substantive one (real `import` tooling to hand off
into); the Ansible path is thinner by nature — Ansible has no state file to import into — and
should be positioned as such, not oversold as symmetric.

**Why it comes after Phase 2, not before:** handoff logic falls out of the step/registry metadata
almost for free *if* that metadata was designed right across a real spread of integrations.
Building it against only the two origin integrations would bake in AWS/Snowflake assumptions and
make it bespoke per integration forever.

**Done when:** a verified run can emit valid, reviewable Terraform imports for its created
resources, and the emitter contains no integration-specific code.

---

## Phase 4 — CLI and MCP

**What:** Two thin adapters over the Phase 1 engine. The CLI exposes uniform verbs
(`plan`, `apply`, `verify`, `handoff`, `init`, `list`, `doctor`). The MCP server exposes each
integration as a tool with honest annotations (`idempotentHint: true`, never `readOnlyHint`),
dry-run by default, and an explicit confirm gate before any mutation. Credentials stay
server-side via native provider chains and are never LLM-visible tool parameters.

**Why it's last:** both are adapters — they add almost nothing to the engine, they *surface* it.
Building MCP before the engine refactor means building it twice; building the CLI's full verb set
before the step model is proven across Phase 2's integrations means designing verbs against
assumptions instead of reality. (`init` and `doctor` are the exception — they're pulled earlier
to fix onboarding friction, since credentials resolve via provider chains rather than a `.env`.)

**Why it may be the most strategically important phase despite being last:** the MCP surface is
the stronger mass-adoption bet than the human CLI. Agents provisioning infrastructure need
exactly Ferry's properties — idempotent (safe to retry on ambiguous outcome), self-verifying,
clean-on-failure — and well-annotated infra primitives for agents are currently scarce. "The safe
way an agent bootstraps cloud infra" is a larger, less-contested position than "a nicer way for a
human to run a setup script."

**Done when:** the CLI runs any integration from a clone via uniform verbs, and the MCP server
exposes the same integrations to an agent with dry-run/confirm safety, both over one shared engine.

---

## The dependency spine, in one line

Engine (P1) → integrations that prove and shape it (P2) → handoff that reads its registry (P3) →
CLI + MCP that surface it (P4). Reorder and you rebuild.

## A note on distribution

None of the four phases requires publishing Ferry. Primary distribution stays clone-and-run from
source — same auditability as today, and a stronger trust story than a binary now that an engineer
can point an agent at ~1,200 lines and audit it in a minute. Publishing (npm / binary) is a
separate, optional decision available later; it is a prerequisite for nothing here.
