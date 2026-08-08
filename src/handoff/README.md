# `src/handoff/` — intentionally empty

This is where the Terraform and Ansible **emitters** will live. Nothing has been
built here yet, on purpose.

What already exists elsewhere:

- `Step.handoff` in `src/core/define.ts` — the declaration each step makes about
  how the resource it manages maps to Terraform (`type`, `address`, `importId`) or
  to an Ansible variable.
- `src/core/registry.ts` — the per-run ledger. For every step that actually created
  or reconciled something, it records the step id, the resource type, the logical
  name, its identifying attributes, and the resolved `handoff` metadata.

Both integrations already populate `handoff` on their steps. The ledger is the
input an emitter will consume; writing that emitter is a later task, and building
it now would fix its shape before the data has been exercised.

Two constraints for whoever gets here next:

- The ledger describes **one run**, not the world. It is not a state file, and
  ferry must never grow one — live cloud state is re-read on every run.
- A step's `handoff` is a claim about mapping, not about ownership. Emitting an
  `import` block is fine; emitting anything that would let ferry and Terraform both
  believe they manage a resource is not.
