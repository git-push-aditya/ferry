# `github/create-or-update-org-secret`

Same shape as `create-or-update-repo-secret`, at the org scope, with one
genuine addition: org secrets carry a `visibility` field (`all` | `private`
| `selected`) and, when `selected`, a list of repo ids allowed to use it.

```bash
bun run bin/ferry.ts github/create-or-update-org-secret --dry-run
bun run bin/ferry.ts github/create-or-update-org-secret
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `ORG`, `SECRET_NAME`,
`SECRET_VALUE`, `VISIBILITY`, `SELECTED_REPOSITORY_IDS` (only used when
`VISIBILITY=selected`), `FORCE_ROTATE`.

## Gotchas

**Visibility/selection genuinely IS readable, unlike the value.** This is
the one place org secrets diverge structurally from repo secrets — `GET
.../actions/secrets/{name}` returns `visibility` inline, and there's a
dedicated endpoint for the selected-repo list. So this task layers a real,
always-reconciled diff for that sub-piece on top of the value's
create-or-skip layer (same two-layer shape as `create-security-group`'s
group-existence-vs-rule-set split).

**Changing the visibility enum still requires resupplying the value.**
GitHub has no way to flip `visibility` between `all`/`private`/`selected`
without a full `PUT` that includes `encrypted_value` again — there is no
"just change this one field" endpoint for the enum itself (only the
selected-repo *list*, when visibility is already `selected`, has its own
independent endpoint). This integration handles that transparently: a
visibility-enum change re-encrypts `SECRET_VALUE` (already held for the
whole run anyway); a selected-repo-list-only change uses the lighter
dedicated endpoint and never touches the value.

**Everything else in `create-or-update-repo-secret`'s Gotchas applies
here too**: write-blind value, `FORCE_ROTATE` escape hatch, and the
non-destructive rollback stance on an overwritten value.
