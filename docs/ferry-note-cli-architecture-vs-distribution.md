# Ferry — Note: CLI-as-architecture vs CLI-as-distribution

## The core distinction

"Should Ferry have a CLI?" is really two unrelated questions wearing one coat. Answer them
separately or you'll make the wrong call on both.

**CLI-as-architecture** — the internal shape of the codebase. One engine, uniform verbs, an
integration registry, a discovery mechanism. This is about how the code is organised, and it is
a *yes* regardless of who ever runs the tool.

**CLI-as-distribution** — how the tool reaches a user's machine. `npm i -g`, a Homebrew formula,
a compiled binary, a curl-pipe-bash installer. This is about packaging and public trust, and it
is a *later, optional* decision that has nothing to do with the architecture question.

The mistake is treating them as one: "people won't trust an installed CLI, so don't build a
CLI." The trust objection is entirely about distribution. It says nothing about architecture.

## Why CLI-as-architecture is not optional

The moment Ferry has more than two integrations, the alternative to a CLI is N bespoke
`bun run` scripts, each re-implementing env loading, credential resolution, dry-run handling,
rollback wiring, and reporting. That guarantees drift: integration #3 handles `--dry-run`
slightly differently from #1, #5 masks secrets a little differently from #2, and nobody can
reason about "how Ferry behaves" because there is no Ferry, just a folder of loosely related
scripts.

A CLI is the single engine that every integration runs through:

- Uniform verbs — `plan`, `apply`, `verify`, `handoff`, `init`, `list`, `doctor` — implemented
  once, behaving identically for every integration.
- A discovery mechanism (`integrations/**/integration.ts`) so adding an integration is creating
  a folder, not editing a central switch statement.
- One place where the invariants live: idempotency, cascading rollback, dry-run, verification,
  masked reporting. Change the rollback policy once, every integration inherits it.

This is worth building **even if the tool is never published and only ever runs inside your
company from a cloned repo.** The payoff is internal consistency and maintainability, not reach.

## Why MCP doesn't let you skip it

MCP wraps the same engine the CLI drives. The tool schema, the confirm gate, the annotations —
they all sit *in front of* `plan`/`apply`/`verify`. So "skip the CLI, go straight to MCP" does
not save the engine work; it just means building the engine with a worse first consumer and no
human-runnable entry point to test against. Build the engine (CLI-as-architecture) first, then
MCP is a thin adapter. Order matters: MCP before the engine refactor means building MCP twice.

## Why the distribution question is genuinely separate — and defers cleanly

Ferry asks for the permission to create IAM roles and trust policies. That is near the top of the
trust hierarchy in developer tooling. A formatter costs nothing to try; Ferry costs a security
review. So the distribution question is real — but it resolves in a direction that removes the
tension with the CLI entirely:

**Primary distribution = clone the repo and run from source.** Not a published binary.

- Same auditability the repo has today. Nothing hidden.
- The 2026 twist that makes this *stronger* than a binary: an engineer can have an agent audit
  ~1,200 lines of TypeScript in about a minute. Source-available-and-small is now a better trust
  story than a signed artifact, because the audit is actually cheap. A compiled binary throws
  that advantage away.
- Running via `bun run ferry <verb> <integration>` from a clone has the ergonomics of a CLI with
  the trust profile of the current scripts. You get the architecture win with zero distribution
  cost.

Publishing to npm / Homebrew / a binary is a decision available in six months if adoption
warrants it. It is a prerequisite for nothing in the T1–T4 plan. And when the time comes, the
right call is almost certainly `npx`/clone-first rather than a compiled binary — precisely
because the audit story *is* the trust story, and hiding the source weakens it.

## Practical implications for the build

1. Build the engine + CLI verbs now (T1 architecture). Assume "run from clone" as the only
   distribution for the foreseeable future.
2. Do **not** publish, do **not** compile a binary, do **not** write an installer in T1–T4.
3. Lean on the trust story deliberately: the README should say, in as many words, "read the
   source — or point an agent at it — before you run this," and make that easy (small, typed,
   commented at the load-bearing steps).
4. Keep the human CLI and the MCP server as two thin adapters over one engine. Neither owns
   logic the other lacks.

## One-line summary

Build the CLI for what it does to the *codebase*, not for how it reaches *users*. The
architecture is a yes today; the distribution is a not-yet, and when it comes it's clone-first,
because being auditable is the whole point.
