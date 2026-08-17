# `github/add-remove-collaborator`

Adds or removes a single repo collaborator at a given permission level.

```bash
bun run bin/ferry.ts github/add-remove-collaborator --dry-run
bun run bin/ferry.ts github/add-remove-collaborator
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`, `USERNAME`,
`ACTION` (`add`/`remove`), `PERMISSION` (required when `ACTION=add`).

## Gotchas

**GitHub gives no clean diff signal here.** `PUT .../collaborators/{username}`
returns **201** for a brand-new invitation and **204** when the user already
had access — but a 204 also fires when *only the permission level changed*
on someone with implicit (org/team-inherited) access. There is no way to
tell "nothing happened" from "permission silently raised" from the response
alone, so this integration reports "ensured" rather than claiming "no
changes made" on a 204.

**No pending-invitation visibility.** `GET .../collaborators/{username}`
(the presence check) returns 404 for both "never invited" and "invited but
not yet accepted" — there is no dedicated pending-invitation endpoint this
task can check instead.

**Rollback of `remove` needs an extra read.** The collaborator-by-username
check only returns 204/404, never a permission level, so removing someone
first reads `GET .../collaborators/{username}/permission` to capture what to
restore on rollback.

**Rollback of `add` cannot always restore correctly.** If the 204-ambiguous
case above happened (an existing implicit permission was silently raised),
rollback removes the explicit grant this run made but cannot restore an
unknown prior permission level, since the API never reported one — logged
as a limitation, not silently glossed over.

**Missing repo aborts in the plan phase.** The repo-existence check lives
inside this task's own `check()` (returning `"conflict"`) rather than a
separate guard step, so a missing repo still aborts before any mutation
while keeping this a genuine one-step task.
