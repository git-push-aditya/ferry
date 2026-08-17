# `github/create-webhook`

Creates a repo webhook and smoke-tests it with a synthetic ping.

```bash
bun run bin/ferry.ts github/create-webhook --dry-run
bun run bin/ferry.ts github/create-webhook
```

## What it needs

**Root `.env`** — `credentials: ["github"]` only (`GITHUB_TOKEN`).

**This folder's `.env`** — see `.env.example`: `OWNER`, `REPO`, `URL`,
`CONTENT_TYPE`, `SECRET`, `EVENTS`, `ACTIVE`.

## Gotchas — read this one

**Webhooks are not uniquely keyed by URL.** GitHub's own docs confirm
"multiple webhooks can share the same config." This is the single biggest
structural surprise in this provider, and the one task where `check()`
cannot be made fully ownership-safe by any mechanism GitHub exposes today:

- Identity here is a best-effort proxy — exact `config.url` + event-set
  equality — not a true ownership guarantee.
- A second, unrelated webhook with an identical URL and identical event
  list will **false-positive** as "exists" and this integration will skip,
  believing its own hook is already there.
- Because of that fuzziness, this task is deliberately **create-or-skip**,
  never always-reconcile: diffing and PATCHing a fuzzy-matched hook risks
  silently mutating a webhook this integration doesn't actually own.

**A failed connectivity ping does not fail `create()`.** The hook is
legitimately created either way — a failed ping just means the receiving
endpoint isn't up yet — so it's logged as a warning, not an error.

**The HMAC secret is write-blind on GitHub's side**, same as Actions
secrets: GitHub never returns it. Handle it with the same hygiene (never
logged, never in `resource()`/reports).

**Rollback is real and complete** — `DELETE` on the captured hook id — but
only for a hook this run's own `create()` made, per the identity caveat
above.
