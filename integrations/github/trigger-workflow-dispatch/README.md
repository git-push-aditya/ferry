# `github/trigger-workflow-dispatch`

Fires a `workflow_dispatch` event and best-effort correlates the resulting
run, optionally waiting for it to complete.

```bash
bun run bin/ferry.ts github/trigger-workflow-dispatch --dry-run
bun run bin/ferry.ts github/trigger-workflow-dispatch
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`,
`WORKFLOW_ID`, `REF`, `INPUTS_JSON`, `WAIT_FOR_COMPLETION`,
`POLL_TIMEOUT_MS`, `EXPECTED_CONCLUSION`.

## Gotchas

**This is a read-only action-trigger, not a state convergence.** `check()`
always returns `"missing"` — every invocation is a fresh dispatch, and
`workflow_dispatch` events aren't idempotent or deduplicated by GitHub in
any way this API exposes. Closest analogue elsewhere in this project:
`audit-unused-roles`'s "every run re-does the read" shape, but for a write.

**GitHub's dispatch call returns 204 with no run id.** There is no
synchronous way to know which resulting run a dispatch triggered. This task
polls `GET .../actions/runs?event=workflow_dispatch` and correlates by
timestamp — a best-effort match, not a guaranteed one. A second, unrelated
dispatch racing this one within the same poll window could be ambiguous.
This is a well-known GitHub API rough edge, not a shortcut this integration
is taking — it's the standard workaround the wider GitHub Actions tooling
ecosystem uses.

**`INPUTS_JSON` is not validated against the workflow's own schema.** A
mismatched input surfaces as whatever 4xx GitHub itself returns — checking
the workflow file's declared `workflow_dispatch.inputs` would require
fetching and parsing its YAML, out of scope here.

**Rollback can cancel, never undo.** A dispatched run cannot be
un-dispatched. If `WAIT_FOR_COMPLETION=true` and the run is still in-flight,
rollback calls the cancel endpoint — logged as a cancellation, not an undo,
same honesty class as `terminate-instance`.

**`verify()` is only as strong as `WAIT_FOR_COMPLETION` allows.** With it
`false`, verification can only confirm the dispatch call was accepted, not
that anything ran or succeeded.
