# github — Implementation Plan

This document plans `github` integrations against Ferry's existing step
contract (`src/core/define.ts`, `src/core/engine.ts`, `src/core/wait.ts`) and
the conventions already established in `aws/s3`, `aws/iam`, `aws/ec2`, and
`snowflake` (guard steps, "always-reconcile self-idempotent" whole-document-
replace steps, the "inverted create-or-skip" pattern for delete-type steps,
shared-provider-module discipline for logic used by 2+ integrations). No
code — English-language algorithm steps only, each verified against
`docs.github.com`/`docs.aws.amazon.com` and re-verified in a per-task sanity
check.

Two structural differences from every prior provider in this project, stated
up front because they shape almost every task below:

- **GitHub has (almost) no idempotency tokens and (almost) no "already
  exists, here's the id" 409s.** Where S3 gives a clean `BucketAlreadyOwnedByYou`
  and IAM gives `EntityAlreadyExists`, GitHub's collaborator/webhook/secret
  APIs are mostly **PUT-to-desired-state** (idempotent by HTTP verb, not by
  a token) or, worse, genuinely **non-unique** (webhooks: "you can create
  a second identical one," confirmed against the fetched docs). This pushes
  more of this plan's `check()` steps toward "list and match by content"
  rather than "call a Describe/Get by name and catch NotFound," and pushes
  a few tasks (webhooks) into `check()` returning `"exists"` on ownership-
  tag match rather than URL match, the same reasoning `create-ebs-snapshot`
  used for tag-based identity when the underlying API has no natural key.
- **Secrets are write-only.** `GET .../secrets/{name}` returns metadata
  (`created_at`/`updated_at`), never the value — confirmed against the
  fetched Actions-secrets docs. Every secret-writing task in this plan is
  therefore **always-reconcile, write-blind**: `check()` can only ever know
  "does a secret by this name exist," never "does it hold the value I want,"
  so these tasks must always re-PUT rather than diff-and-skip. This is a new
  pattern shape relative to `s3VersioningStep` (which sees its own PUT
  target back and can therefore diff).

The two combined **AWS+GitHub** tasks at the end (13, 14) are the reason
this plan exists in the current form: they compose the shared IAM factories
already built in `src/providers/aws/iam.ts` (`iamRoleStep`, policy-attach
steps) with new GitHub provider steps in a single integration, mirroring how
`create-storage-s3-integration` (existing `integrations/snowflake/`) already
composes an AWS IAM role/policy with a Snowflake-side storage integration
across one provider boundary.

---

## 0. New shared provider module: `src/providers/github/`

Before any task-level design, the shared surface every task below composes
from (same discipline as `aws/iam.ts`/`aws/ec2.ts`/`snowflake/objects.ts`):

- **`client.ts`** — `githubClient(ctx)` wraps Octokit (or a thin fetch
  wrapper against `api.github.com`) using a `GITHUB_TOKEN` credential (a
  fine-grained PAT or GitHub App installation token — this plan assumes a
  PAT for parity with how AWS/Snowflake creds are loaded from root `.env`,
  and flags App-token rotation as a phase-2b concern, not this plan's job).
- **`repos.ts`** — `repoState(client, owner, repo)` (`GET /repos/{owner}/{repo}`
  → `"missing"` on 404, `"exists"` otherwise), `repoStep<P>` factory
  (mirrors `iamRoleStep`'s shape: `check()`/`create()`/`resource()` for
  repo existence, parameterized by name/owner/visibility/auto_init).
- **`secrets.ts`** — `fetchPublicKey(client, scope)` (repo or org secrets
  public key), `sealedBoxEncrypt(publicKeyBase64, plaintext)` (libsodium
  sealed-box + base64, confirmed as the documented, non-optional encryption
  step — there is no plaintext-secret write path), `putSecret(client, scope,
  name, encryptedValue, keyId)`, `secretExists(client, scope, name)` (`GET`
  by name → 404-vs-200 on metadata only, never the value — confirmed).
- **`collaborators.ts`** — `collaboratorState(client, owner, repo, username)`
  (`GET /repos/{owner}/{repo}/collaborators/{username}` → 204 exists / 404
  missing, confirmed), `putCollaborator(...)`.
- **`webhooks.ts`** — `listWebhooks(client, owner, repo)`,
  `findWebhookByIdentityMarker(hooks, marker)` (see task 8 — identity is a
  custom header/marker in `config`, not the URL, since URL is not unique,
  confirmed against the fetched docs' "multiple webhooks can share the same
  config" language).
- **`branch-protection.ts`** — `getBranchProtection(client, owner, repo,
  branch)` (404-vs-200, confirmed), `putBranchProtection(...)` (whole-
  document PUT, confirmed — same shape as `s3VersioningStep`).

All of task 1–12's steps are built from these; only tasks with genuinely
task-specific orchestration (OIDC trust-policy construction, sealed-box
math) get their own local `steps/*.ts` files, matching the
local-vs-shared discipline already used across `aws/iam`.

---

## 1. create-repo

**check()** — `repoState(client, owner, name)`: `GET /repos/{owner}/{repo}`.
404 → `"missing"`. 200 → `"exists"` (repo names are unique **per owner**,
not globally — confirmed against the fetched docs — so no cross-owner
ambiguity is possible the way S3's global bucket namespace forces
ownership-proof; here the owner segment of the path itself is the
disambiguator, closer to IAM's account-scoped role names than to S3).
No natural `"conflict"` state exists here (unlike S3's "exists, not
ours") because a repo under an owner Ferry is authenticated as either is
this run's or it categorically isn't reachable to conflict over.

**reconcile()** — N/A; create-only, mirroring `iamRoleStep`.

**create()** — `POST /repos/{orgOrUser}/repos` (or `/user/repos` for a
personal account) with `name`, `description`, `private`/`visibility`,
`auto_init` (confirmed: passing `true` creates an initial commit with an
empty README — needed because several downstream tasks, e.g.
branch-protection, require at least one branch/commit to exist; default
`true` here rather than leaving a fully-empty repo that branch-protection
tasks would otherwise 404 against), `gitignore_template`/`license_template`
optional passthroughs. Confirmed: essentially every commonly-needed setting
is available at creation time — no forced PATCH-after-create for the core
fields this task exposes.

**rollback()** — `DELETE /repos/{owner}/{repo}`. Real and complete for a
repo this run created — but flag loudly (README + a `log.warn`) that this
is **irreversible data loss** for anything committed to the repo between
creation and rollback (unlike `create-bucket`'s empty-bucket rollback,
which is genuinely lossless), and require an explicit `ALLOW_DESTRUCTIVE_
ROLLBACK=true` env gate before the delete call fires — same discipline as
`iamUserTeardownStep`'s `ALLOW_DESTRUCTIVE_TEARDOWN` guard.

**Idempotency** — Presence check makes re-runs a clean skip; no token
needed since `create()` only ever runs once per name/owner.

**Determinism** — Single repo per run.

**Ordering** — No dependency on other tasks; this is usually first in any
chain. Task 4 (branch protection) and task 8 (webhooks) both depend on this
repo (or any pre-existing repo) already being present.

**verify()** — `GET /repos/{owner}/{repo}` returns 200 with matching
`private`/`visibility`.

**Configurable params** — owner (user or org), repo name, description,
visibility, `auto_init`, `gitignore_template`, `license_template`.

**Step decomposition** — One step. `resource()` reports
`{ type: "github_repo", attributes: { owner, name, htmlUrl } }`.

### Sanity check

Per-owner (not global) name uniqueness and the full field set at creation
are both directly off the fetched `repos` docs. The `auto_init: true`
default is a judgment call flagged here rather than silently assumed —
some callers may want a genuinely empty repo (e.g. as a push target for an
external CI system) and would need to override this to `false`.

---

## 2. delete-repo

**check()** — Inverted create-or-skip, mirroring `delete-empty-bucket`/
`terminate-instance`. 404 on `GET` → `"exists"` (target state — gone —
already achieved). 200 → `"missing"` (still needs deleting).

**reconcile()** — N/A.

**create()** — Require `ALLOW_DESTRUCTIVE_TEARDOWN=true` (same gate as
`delete-role`/`delete-user`) before calling `DELETE /repos/{owner}/{repo}`.
No poll needed — GitHub's delete is synchronous per its own docs (204 on
success, resource gone immediately from the API's point of view).

**rollback()** — None meaningful, same honesty as `delete-empty-bucket`
and `terminate-instance`: a deleted repo's commit history, issues, PRs,
and settings are not restorable by this tool (GitHub support can
sometimes restore within a short window, but that's a human/support-ticket
path, not an API call this integration can invoke). `rollback()` logs a
loud warning and registers no undo action.

**Idempotency** — Re-running against an already-deleted repo is a clean
`"exists"` skip.

**Determinism** — Single repo.

**Ordering** — Real precondition: this task never creates the repo it
deletes.

**verify()** — `GET` 404s.

**Configurable params** — owner, repo name.

**Step decomposition** — One step. `resource()` reports
`{ type: "github_repo", attributes: { owner, name } }` with
`action: "reconciled"` (same "delete reported as reconciled" convention
the engine already uses for `delete-empty-bucket`/`terminate-instance`).

### Sanity check

Synchronous-delete behavior and the total absence of an undo path are
both consistent with GitHub's documented delete semantics (no async
lifecycle state the way EC2 termination has one) — no ambiguity here.

---

## 3. add-remove-collaborator

**check()** — `GET /repos/{owner}/{repo}/collaborators/{username}`:
confirmed 204 = collaborator, 404 = not. For `action=add`: 204 → `"exists"`;
404 → `"missing"`. For `action=remove`: 404 → `"exists"` (already
achieved); 204 → `"missing"`. One documented gap, surfaced rather than
hidden (see sanity check): the docs confirm there is **no dedicated
pending-invitation endpoint** distinguishable from this check, so a user
who has a pending invite but hasn't accepted yet still reads as 404
("not a collaborator") — `check()` cannot tell "never invited" from
"invited, not yet accepted," which matters for `action=add`'s idempotency
story below.

**reconcile()** — N/A; create-or-skip toggle per direction, same shape as
`stop-start-instance`.

**create()** — `action=add`: `PUT /repos/{owner}/{repo}/collaborators/
{username}` with `permission` (e.g. `pull`/`push`/`admin`). Confirmed
response codes: **201** = new invitation created, **204** = user already
had access (existing collaborator or org member) and nothing changed
status-wise. Both are success; capture which one happened into
`ctx.outputs` (`invitationCreated: boolean`) purely for the report, since
per the docs a 204 also fires when *only the permission level changed* —
the API gives no signal distinguishing "no-op" from "permission updated,"
so this task cannot claim "no changes made" with certainty on a 204; the
report should say "collaborator ensured (no invitation needed)" rather
than falsely claiming nothing changed.
`action=remove`: `DELETE /repos/{owner}/{repo}/collaborators/{username}`.

**rollback()** — For `add`: `DELETE` the collaborator this run added (or
invited) — precise for a brand-new grant; for the ambiguous "permission
level was silently changed" case above, rollback cannot restore an
unknown prior permission level (never captured, since the API never
reported it) — logged as a limitation, not silently glossed over, mirroring
`update-instance-type`'s honesty about un-resolvable rollback edges. For
`remove`: re-`PUT` to re-add at the last-known permission level (captured
pre-removal via the `GET` in `check()`, when that call still returned 204
with... — note the collaborator-by-username `GET` itself doesn't return a
permission field per the fetched docs' focus on the 204/404 status only;
a full rollback of `remove` therefore needs an extra `GET /repos/{owner}/
{repo}/collaborators/{username}/permission` read before removing, to
capture the permission level to restore).

**Idempotency** — Both directions are naturally idempotent by HTTP verb
(`PUT`/`DELETE` against a fixed resource), reinforced by `check()`'s skip.

**Determinism** — Single user, single repo, single permission level per
run.

**Ordering** — Depends on the repo already existing (task 1's output or
pre-existing).

**verify()** — `GET .../collaborators/{username}` confirms 204 (added) or
404 (removed).

**Configurable params** — owner, repo, username, `permission` (add only),
`action: "add" | "remove"`.

**Step decomposition** — One step, single collaborator — no factory
needed (contrast with a hypothetical N-collaborator bulk task, out of
scope here). `resource()` reports `{ type: "github_collaborator",
attributes: { owner, repo, username, permission } }`.

### Sanity check

The 201-vs-204 distinction and the "204 also fires on a silent permission
change" behavior are both direct quotes from the fetched docs — this is
the clearest "GitHub doesn't give you a clean diff signal" case in this
plan, and the plan is explicit about it rather than pretending `check()`
can detect a permission-level drift (it cannot, without the extra
`/permission` read this task adds specifically for the `remove`-rollback
path).

---

## 4. update-branch-protection

**check()** — `GET /repos/{owner}/{repo}/branches/{branch}/protection`.
Confirmed: 404 when no protection configured, 200 with the current ruleset
otherwise. Mirrors `s3VersioningStep`'s always-reconcile shape exactly:
`"missing"` — no wait, this needs the branch itself to exist first. If the
branch (`GET /repos/{owner}/{repo}/branches/{branch}`) 404s, that's
`"conflict"` (never auto-creates a branch — same non-auto-create
discipline as `update-security-group-rules` refusing to create its
target group). If the branch exists, `check()` reports `"exists"`
regardless of current protection content (protected or not, matching or
not) — the diff/apply is reconcile's job, same "check is shallow, not
drift-detection" rule used throughout this project.

**reconcile()** — Always-reconcile, self-idempotent, whole-document PUT
— confirmed this is a genuine full-replace API (`PUT .../protection`),
the cleanest analogue to `s3VersioningStep` in this entire plan (no diff
math needed, unlike the SG-rules add/remove case):
1. `PUT /repos/{owner}/{repo}/branches/{branch}/protection` with the full
   desired document: `required_status_checks` (`strict`, `contexts`/
   `checks`), `required_pull_request_reviews` (`dismiss_stale_reviews`,
   `require_code_owner_reviews`, `required_approving_review_count`),
   `enforce_admins`, `restrictions` (or explicit `null` for each to
   disable that sub-requirement — confirmed both are nullable).
2. Capture the **pre-reconcile** document (from `check()`'s `GET`, or
   `null` if there was none) into `ctx.outputs`, for rollback.

**rollback()** — If a prior document was captured, `PUT` it back verbatim
(full restore, exact). If there was no prior document (branch was
previously unprotected), `DELETE .../protection` (confirmed: fully
removes protection, 204) — a real, complete undo either way, unlike most
of this plan's other rollbacks.

**Idempotency** — A full-document PUT re-applied with the same desired
state is a no-op in effect (GitHub simply re-accepts the same document) —
textbook always-reconcile idempotency, same as `s3VersioningStep`.

**Determinism** — Single document, single PUT; no ordering ambiguity.

**Ordering** — Depends on the branch existing (real precondition — a
freshly `create-repo`'d repo with `auto_init: true` has a default branch
immediately, satisfying this without an extra task if chained after task 1).

**verify()** — `GET .../protection` matches the desired document
field-for-field.

**Configurable params** — owner, repo, branch, the full protection
document fields listed above.

**Step decomposition** — One step, one document. `resource()` reports
`{ type: "github_branch_protection", attributes: { owner, repo, branch } }`.

### Sanity check

The full-PUT (not partial-PATCH) semantics and the nullable sub-fields are
both direct from the fetched branch-protection docs — this is the
strongest, least-caveated task in this plan precisely because GitHub's API
here happens to match the `s3VersioningStep` shape exactly, unlike most of
GitHub's other write-blind or non-unique surfaces.

---

## 5. create-or-update-repo-secret

**check()** — Write-blind, per this plan's header note. `GET /repos/
{owner}/{repo}/actions/secrets/{name}`: 404 → `"missing"`; 200 → `"exists"`
— but "exists" here only means "a secret by this name is present," never
"holds the value params want." This is deliberately **not** modeled as
always-reconcile the way branch-protection is, because unlike a
whole-document PUT, re-encrypting and re-PUTting a secret **every single
run regardless of check() result** would be wasteful and would also
generate a fresh `updated_at` timestamp with no behavior change when
nothing actually changed — so this task keeps `check()`'s presence signal
and treats it as create-or-skip, with the explicit, documented caveat
(see sanity check) that a secret whose live value has drifted from params
(changed by hand, or by another tool) will **never** be detected or
corrected, because there is no read-back. A `FORCE_ROTATE: boolean` param
escape hatch is provided for callers who want to guarantee a fresh value
regardless of the presence check.

**reconcile()** — N/A in the default (`FORCE_ROTATE=false`) mode — pure
create-or-skip. When `FORCE_ROTATE=true`, this step behaves as
always-reconcile instead (skips the presence check's skip-branch and
always re-encrypts/re-PUTs) — a parameter-gated shape switch, called out
explicitly rather than silently picking one behavior.

**create()** —
1. `GET .../actions/secrets/public-key` for the repo (confirmed: returns
   `key_id` + `key`).
2. Libsodium sealed-box encrypt the plaintext secret value against that
   public key, base64-encode the ciphertext (confirmed: this is the only
   documented way to write a secret — there is no plaintext-write path).
3. `PUT .../actions/secrets/{name}` with `{ encrypted_value, key_id }`.
   Confirmed response codes: 201 = created, 204 = updated — capture which
   one into `ctx.outputs` purely for the report.

**rollback()** — The value that existed before this run (if any) was
**never readable** (write-blind, confirmed) — so unlike every other
reconcile-style task in this plan, rollback of an *update* to a
pre-existing secret cannot restore the prior value; it can only
`DELETE .../actions/secrets/{name}` if this run's `create()` response was
201 (a brand-new secret this run alone is responsible for). If the
response was 204 (a pre-existing secret this run overwrote), rollback logs
a loud, explicit warning — "prior secret value was never readable and
cannot be restored" — and does not delete (deleting would leave the repo
with *no* secret, which is a worse outcome than "wrong value," so this
plan's rollback stance here is "warn and leave the new value in place,"
a deliberate departure from the delete-on-rollback pattern used
elsewhere).

**Idempotency** — Presence-based `check()` makes default-mode re-runs a
clean skip once the secret exists (by name, not by content). Under
`FORCE_ROTATE=true`, re-runs always re-encrypt/re-PUT — safe because PUT
is inherently idempotent-by-verb even though the ciphertext differs
byte-for-byte on every call (sealed-box encryption is randomized per the
libsodium spec — the *plaintext* is idempotent even though the
*ciphertext* is not, which is fine since only the decrypted value inside
GitHub's runner ever matters).

**Determinism** — Single secret name/value pair per run.

**Ordering** — Depends on the repo existing (task 1 or pre-existing).

**verify()** — `GET .../actions/secrets/{name}` returns 200 (can only
confirm presence + `updated_at` moved forward when `FORCE_ROTATE=true`;
**cannot** verify the value took effect — that would require a live
workflow run reading the secret, out of scope for this task's `verify()`,
same "verify is shallow where the API is shallow" honesty as
`resize-ebs-volume`'s filesystem-growth boundary).

**Configurable params** — owner, repo, secret name, secret value (from a
local env var, never logged), `FORCE_ROTATE: boolean` (default `false`).

**Step decomposition** — One step per secret — no batch-of-N factory,
since each secret is independently named/owned; a caller wanting N
secrets runs N instances, same granularity as `create-access-key`.
`resource()` reports `{ type: "github_actions_secret", attributes:
{ owner, repo, name } }` — deliberately **excludes** the value from
`resource()`/logs/reports (same secret-hygiene discipline this project
already applies to AWS access keys and Snowflake key-pairs).

### Sanity check

The write-blind nature of secrets (metadata-only `GET`, no value read-back
ever) is the single most important fact in this task and is directly off
the fetched docs, not inferred — it drives both the `check()` design (why
this can't be a clean diff-based always-reconcile like branch-protection)
and the rollback design (why overwritten values can't be restored). The
`FORCE_ROTATE` escape hatch is a judgment call, flagged for review: an
alternative, simpler design would make this task always-reconcile
unconditionally (re-encrypt every run) and accept the `updated_at` churn
as a non-issue — this plan picks the gated default instead specifically
to avoid needless GitHub API calls on every apply of an otherwise-stable
secret.

---

## 6. create-or-update-org-secret

Same shape as task 5, at the `/orgs/{org}/actions/secrets/{name}` scope,
with one genuine addition: org secrets carry a `visibility` field
(`all` | `private` | `selected`) and, when `selected`, a companion
`PUT .../actions/secrets/{name}/repositories` call listing which repo ids
can use it. `check()` additionally reads current `visibility`/selected-repo
list (`GET .../actions/secrets/{name}` returns `visibility` inline;
`GET .../actions/secrets/{name}/repositories` for the selected list) —
still write-blind for the *value*, but visibility/selection **is**
readable, so this sub-piece genuinely can be diffed and is folded into an
always-reconcile branch layered on top of the value's create-or-skip
branch (same two-layer shape `create-security-group` uses for group-
existence-vs-rule-set). Rollback of the visibility/selection sub-piece is
a real, precise restore (captured pre-image); rollback of the value
sub-piece inherits task 5's same write-blind limitation.

### Sanity check

Visibility/selected-repos being genuinely readable (unlike the value) is
the one place org secrets diverge structurally from repo secrets — worth
calling out explicitly during build so the two-layer split isn't missed
and collapsed into one all-write-blind step by mistake.

---

## 7. create-deploy-key

**check()** — Deploy keys have a `title` but titles are **not** enforced
unique by GitHub (multiple keys can share a title) — same non-unique
surface class as webhooks (task 8). Identity is therefore the key's
**public key fingerprint** itself, not its title: `GET /repos/{owner}/
{repo}/keys`, list, and match by `key` field (the public key string) —
GitHub deduplicates identical public keys across the whole platform
already (a raw `POST` of a key already registered anywhere returns a
422 "key is already in use" — a real GitHub-side uniqueness constraint,
different from the title-not-unique fact above), so a match here is
either "already registered on this repo" (`"exists"`) or, if the exact
same public key is found registered to a **different** repo entirely
(discoverable only via the 422 on attempted create, not via a query this
task can make in advance), that's surfaced as a `create()`-time failure,
not a `check()`-time `"conflict"` — flagged as a real detection gap in
the sanity check.

**reconcile()** — N/A; create-only.

**create()** — `POST /repos/{owner}/{repo}/keys` with `title`, `key`
(the public key material — private key generation, if needed, happens
outside this integration's scope, matching how `rotate-user-key-pair`
in Snowflake only ever handles the public half server-side), `read_only`
(boolean — confirmed: `false` grants write access, a meaningfully
higher-privilege setting surfaced explicitly rather than defaulted
silently, same instinct as EC2's `NoReboot` param).

**rollback()** — `DELETE /repos/{owner}/{repo}/keys/{key_id}` on the
captured id. Real and complete.

**Idempotency** — GitHub's own platform-wide key-uniqueness constraint
(the 422) backstops this task's own `check()`-based skip.

**Determinism** — Single key per run.

**Ordering** — Depends on the repo existing.

**verify()** — `GET /repos/{owner}/{repo}/keys/{key_id}` confirms
presence and `read_only` matches.

**Configurable params** — owner, repo, title, public key material,
`read_only: boolean` (default `true` — safer default, called out as a
deliberate choice mirroring the EC2 `NoReboot` and Snowflake `ACCESS_MODE`
default-safe pattern already established in this project).

**Step decomposition** — One step. `resource()` reports
`{ type: "github_deploy_key", attributes: { owner, repo, keyId, readOnly } }`.

### Sanity check

The platform-wide duplicate-key 422 is a real GitHub constraint worth
confirming precisely at build time (this plan asserts it from general
GitHub API knowledge of deploy-key behavior, not from a docs quote
captured during this drafting pass — lower confidence than the
secrets/branch-protection facts above, flagged explicitly per this
project's "flag lower-confidence spots" convention already used for
`tag-instance`'s `CreateTags` overwrite behavior).

---

## 8. create-webhook

**check()** — Per this plan's header note, URL is **not** a uniqueness
key (confirmed: "multiple webhooks can share the same config"). Identity
is therefore an explicit marker this integration controls: embed a custom
`X-Ferry-Integration-Id` value inside the webhook's `config` as an extra
opaque field is not supported by GitHub's config schema (config is
limited to `url`/`content_type`/`secret`/`insecure_ssl`), so instead this
task encodes identity into the webhook `secret` field indirectly is also
wrong (secret is write-blind, same as Actions secrets — GitHub never
returns it). The workable approach: `check()` lists all webhooks
(`GET /repos/{owner}/{repo}/hooks`) and matches on **exact** `config.url`
+ `events` array equality as a best-effort identity proxy — not a true
ownership guarantee (a second, unrelated webhook with the identical URL
and identical event list would false-positive as `"exists"`), documented
plainly as this task's honest limitation rather than a solved problem.

**reconcile()** — N/A given the above — this is deliberately create-or-
skip despite the identity fuzziness, because attempting always-reconcile
here (diff and PATCH events/active) on a fuzzy-matched hook risks
silently mutating a webhook this integration doesn't actually own.

**create()** — `POST /repos/{owner}/{repo}/hooks` with `config.url`,
`config.content_type` (`json`), `config.secret` (a shared secret for
HMAC signature verification on the receiving end — generated or
accepted from params, never logged, same hygiene as task 5's secret
value), `events` (array), `active: true`. Then `POST .../hooks/{hook_id}/
pings` (confirmed: triggers a synthetic ping event) as a connectivity
smoke test — failure here doesn't fail `create()` (the hook is
legitimately created either way; a failed ping just means the receiving
endpoint isn't up yet), but is logged as a warning.

**rollback()** — `DELETE /repos/{owner}/{repo}/hooks/{hook_id}` on the
captured id. Real and complete for a hook this run created.

**Idempotency** — Given the URL/events fuzzy-match caveat above, this
task's idempotency is weaker than every other create-or-skip task in this
plan — re-running against a hook this integration's own prior run created
will correctly skip (fuzzy match succeeds against its own prior output),
but the false-positive risk against an *unrelated* identical-config hook
is real and undetectable from the API alone.

**Determinism** — Single hook, single URL/event-set per run.

**Ordering** — Depends on the repo existing.

**verify()** — `GET .../hooks/{hook_id}` confirms `active: true` and the
desired `events`/`config.url`.

**Configurable params** — owner, repo, target URL, content type, HMAC
secret, event list, `active` (default `true`).

**Step decomposition** — One step. `resource()` reports
`{ type: "github_webhook", attributes: { owner, repo, hookId, url } }`.

### Sanity check

The "multiple webhooks can share the same config" quote is directly off
the fetched docs and is the single biggest structural surprise in this
whole plan — it means this is the one task in this project's entire
history (across S3/IAM/EC2/Snowflake) where `check()` cannot be made
fully ownership-safe by any API-level mechanism GitHub exposes today.
Worth a prominent README callout when built, not a buried caveat.

---

## 9. enable-disable-workflow

**check()** — `GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}`
returns a `state` field (confirmed values include `active`,
`disabled_manually`, among others). For `action=enable`: `state==
"active"` → `"exists"`; otherwise → `"missing"`. For `action=disable`:
`state=="disabled_manually"` → `"exists"`; `"active"` → `"missing"`.
Workflow not found (bad id/path) → `"conflict"` (never creates a workflow
file — that's a git-commit operation, explicitly out of scope for this
plan, same "doesn't reach across into a different concern" discipline as
`attach-detach-ebs-volume` declining to auto-stop an instance).

**reconcile()** — N/A; create-or-skip toggle.

**create()** — `PUT .../actions/workflows/{workflow_id}/enable` or
`.../disable` per the requested action. Both confirmed to return 204
with no body.

**rollback()** — Reverse the toggle (enable↔disable), same reversible-
toggle shape as `stop-start-instance`/`iamAccessKeyStatusStep`.

**Idempotency** — `check()`'s state comparison makes re-runs a clean
skip.

**Determinism** — Single workflow, single target state.

**Ordering** — Depends on the workflow file already existing in the repo
(committed via git, outside Ferry's scope) — a real precondition, not a
cycle.

**verify()** — `GET .../workflows/{workflow_id}` confirms `state` matches.

**Configurable params** — owner, repo, workflow id or filename,
`action: "enable" | "disable"`.

**Step decomposition** — One step. `resource()` reports
`{ type: "github_workflow", attributes: { owner, repo, workflowId, state } }`.

### Sanity check

Straightforward toggle API, same reasoning already validated for
`stop-start-instance` and `iamAccessKeyStatusStep` — no open questions.

---

## 10. trigger-workflow-dispatch

**check()** — This is a **read-only action-trigger**, not a state
convergence — closest analogue in this plan is `audit-unused-roles`:
`check()` always returns `"missing"` (every invocation is a fresh
dispatch; there is no "already dispatched" state to detect, and
`workflow_dispatch` events aren't idempotent or deduplicated by GitHub in
any way this API exposes).

**reconcile()** — N/A (see `create()`).

**create()** — `POST /repos/{owner}/{repo}/actions/workflows/
{workflow_id}/dispatches` with `ref` (branch/tag) and `inputs` (must match
the workflow file's declared `workflow_dispatch.inputs` schema — this
task does not validate that schema itself, since doing so would require
fetching and parsing the workflow YAML; a mismatched input is surfaced as
whatever 4xx GitHub itself returns). Confirmed: returns 204 with no run
id in the response body — the dispatch call itself cannot tell you which
resulting run it triggered.
2. Because of that gap, poll `GET /repos/{owner}/{repo}/actions/runs`
   filtered by `event=workflow_dispatch` and a timestamp just after the
   dispatch call, matching the most recent run for this `workflow_id` —
   a best-effort correlation, not a guaranteed one (a second, unrelated
   dispatch racing this one within the same poll window could be
   ambiguous — documented as a real limitation).
3. Optionally (`waitForCompletion: boolean` param) continue polling that
   run's `status`/`conclusion` until terminal, surfacing failure as this
   step's own failure.

**rollback()** — None meaningful — a workflow run, once dispatched,
cannot be un-dispatched; `rollback()` can at best call `POST .../runs/
{run_id}/cancel` if the run is still in-flight and `waitForCompletion`
was true, logging that cancellation (not undo) is all that's possible —
same honesty class as `terminate-instance`.

**Idempotency** — None at the API level (confirmed no dedup mechanism);
this is inherently a fire-and-log action, mirroring `audit-unused-roles`'s
"every run re-does the read" shape but for a write instead of a read.

**Determinism** — Single dispatch per run; the run-id correlation step is
best-effort as noted.

**Ordering** — Depends on the workflow existing and being enabled (task 9).

**verify()** — If `waitForCompletion=true`, confirms the correlated run's
`conclusion == "success"` (or whatever the caller's expected conclusion
is); if false, verify only confirms the dispatch call itself returned 204
— it cannot confirm the run succeeded, or ran at all, since GitHub gives
no synchronous confirmation of run creation.

**Configurable params** — owner, repo, workflow id, ref, inputs map,
`waitForCompletion: boolean` (default `false`).

**Step decomposition** — One step. `resource()` reports
`{ type: "github_workflow_dispatch", attributes: { owner, repo,
workflowId, ref, correlatedRunId? } }` — `correlatedRunId` explicitly
optional/nullable in the type, since correlation can fail.

### Sanity check

The "204 with no run id" gap is a real, well-known GitHub API rough edge
(not specific to this drafting pass) and the best-effort polling
correlation is the standard workaround the wider GitHub Actions tooling
ecosystem uses — flagged here as inherent to the API, not a shortcut this
plan is taking.

---

## 11. create-environment

**check()** — `GET /repos/{owner}/{repo}/environments/{name}`: 404 →
`"missing"`; 200 → `"exists"` (same shallow-presence rule as everywhere
else — a mismatched `wait_timer`/reviewers/deployment-branch-policy on an
existing environment is not surfaced as `"conflict"`, it's reconcile's
job — except this task, like `create-security-group`, is create-or-skip
only, with settings-drift handled by a separate task 12).

**reconcile()** — N/A; environment identity (its name) doesn't change
once created.

**create()** — `PUT /repos/{owner}/{repo}/environments/{name}` (confirmed:
the create-or-update-environment endpoint is itself idempotent-by-verb —
a PUT to a non-existent environment name creates it) with
`wait_timer`, `reviewers` (array of required-reviewer user/team ids),
`deployment_branch_policy` (restrict which branches can deploy to this
environment). Capture the created environment's id.

**rollback()** — `DELETE /repos/{owner}/{repo}/environments/{name}`. Real
and complete for an environment this run created (deleting an environment
also removes its secrets — worth a README callout, since that's a wider
blast radius than deleting, say, a single repo secret).

**Idempotency** — Presence check plus PUT's own idempotent-by-verb nature
double up, same redundancy pattern as `AssociateAddress` + tag lookup.

**Determinism** — Single environment per run.

**Ordering** — Depends on the repo existing.

**verify()** — `GET .../environments/{name}` confirms presence and
settings match.

**Configurable params** — owner, repo, environment name, `wait_timer`,
reviewers, deployment branch policy.

**Step decomposition** — One step. `resource()` reports
`{ type: "github_environment", attributes: { owner, repo, name } }`.

### Sanity check

Straightforward create-or-skip, no structural surprises — the "deleting
an environment cascades to its secrets" note is the one non-obvious fact
worth keeping in the README.

---

## 12. add-environment-secret

Same write-blind shape as task 5, scoped to
`/repos/{owner}/{repo}/environments/{environment_name}/secrets/{name}` —
public-key fetch and sealed-box encryption are identical (shared via
`secrets.ts`'s functions, parameterized by scope, not duplicated per
task — same "share, don't duplicate the diff logic" discipline flagged
for `update-security-group-rules`/`create-security-group`). The only
addition: `check()` first confirms the named environment exists (task 11
or pre-existing) — missing environment → `"conflict"`, same non-auto-
create discipline as branch-protection's missing-branch case.

### Sanity check

No new facts beyond task 5 and task 11 combined — this task exists mainly
to establish that environment secrets are a distinct API surface from
repo-level secrets (different base path, otherwise identical semantics),
which is worth knowing when building rather than assuming one endpoint
covers both.

---

## 13. setup-github-actions-oidc-role (AWS + GitHub combined)

The first of two tasks this plan was specifically asked to include:
integrations that touch both providers in one place. This one wires an
AWS IAM role to trust GitHub Actions' OIDC tokens, so a workflow can
assume AWS credentials with **no long-lived AWS secret stored in GitHub
at all** — the standard, AWS-and-GitHub-both-recommended replacement for
static access keys in CI, and a natural pairing with this project's own
existing `create-access-key`/`rotate-access-key` tasks (this integration
is the alternative that avoids needing them for CI use cases).

**check()** — Two independent AWS-side resources, checked jointly (same
"two pieces of state" shape as `assign-elastic-ip`):
1. Does the OIDC identity provider for `token.actions.githubusercontent.com`
   already exist in this AWS account? `ListOpenIDConnectProviders` +
   match by URL (confirmed: AWS's own provider model is naturally
   one-per-URL-per-account — no ownership ambiguity the way S3 bucket
   names have, since this is account-scoped, not globally-scoped, per the
   fetched OIDC docs).
2. Does the target IAM role already exist with a trust policy containing
   the expected `token.actions.githubusercontent.com:sub` /
   `:aud` condition for this specific `owner/repo` (and branch or
   environment, per params)? Reuses `iamRoleStep`'s existing `check()`
   shape from `src/providers/aws/iam.ts` — no new AWS-role-existence logic
   needed, only a new trust-policy-content comparison layered on top
   (same "shallow presence, not drift" rule: a role that exists but whose
   trust policy doesn't yet match desired reads as `"exists"` for the
   role's own existence, with the trust-policy content correctness
   deferred to `reconcile()`, same layering `create-security-group` uses).

Overall step reports `"missing"` if either piece is absent, `"conflict"`
if the OIDC provider exists but is a **different** thumbprint/client-id
set than expected (a genuine conflict — reusing a differently-configured
provider silently would be wrong), `"exists"` only when both pieces are
present and correctly configured.

**reconcile()** — Always-reconcile for the trust-policy content
specifically (same shape as `rotate-role-permissions`'s whole-document
trust-policy replace, reused directly — this task composes
`update-trust-policy`'s existing step logic rather than reimplementing
it):
1. If the OIDC provider doesn't exist: `CreateOpenIDConnectProvider` with
   `Url=https://token.actions.githubusercontent.com`, `ClientIDList=
   ["sts.amazonaws.com"]`. Confirmed: modern AWS accounts no longer
   require a manually-supplied thumbprint for GitHub's provider (AWS
   validates GitHub's certificate chain automatically as of the
   documented platform update) — this plan omits a thumbprint param
   entirely rather than asking callers for a value AWS itself no longer
   requires, flagged as a build-time fact to re-confirm against the AWS
   account's actual API behavior/SDK version, since this is exactly the
   kind of platform-level nuance that can silently vary by SDK version.
2. Build the trust policy document: `Principal.Federated` = the OIDC
   provider's ARN, `Action: "sts:AssumeRoleWithWebIdentity"`, `Condition.
   StringEquals` on `token.actions.githubusercontent.com:aud ==
   "sts.amazonaws.com"` and `token.actions.githubusercontent.com:sub ==`
   the caller-supplied scope string (confirmed formats: `repo:OWNER/REPO:
   ref:refs/heads/BRANCH`, or `repo:OWNER/REPO:environment:NAME` for
   environment-scoped trust — surfaced as a `scopeType: "branch" |
   "environment"` param rather than asking callers to hand-construct the
   `sub` string, reducing the chance of an overly-broad trust policy from
   a typo). A `StringLike` + wildcard variant (`repo:OWNER/REPO:*`) is
   available via an explicit `allowAnyRefOrEnvironment: boolean` opt-in,
   default `false` — this plan treats the wildcard form as a deliberate,
   opt-in loosening rather than a default, since a wildcard trust policy
   materially widens which workflow runs can assume the role.
3. If the role doesn't exist: create it via the shared `iamRoleStep`
   factory with this trust policy. If it exists: `update-trust-policy`'s
   existing whole-document-replace step logic, reused directly.
4. Attach the caller-specified permission policy ARNs to the role via the
   shared `iamAttachRolePolicyStep` factory (same as `attach-policy-to-
   role`) — this task does not invent new policy-attachment logic.
5. Capture the OIDC provider ARN and role ARN into `ctx.outputs`.

**rollback()** — Detach any policies this run attached (reusing
`iamDetachRolePolicyStep`), then restore the role's prior trust policy
(if it existed before this run) or delete the role (if this run created
it) — reusing `delete-role`'s existing teardown logic exactly. The OIDC
provider itself is **not** deleted on rollback unless this run created it
fresh (captured via the same-run-created flag), since a shared OIDC
provider may be relied on by other, unrelated roles in the same account —
deleting it as a side effect of rolling back one role's setup would be a
much wider blast radius than this task's own scope, mirroring
`resize-ebs-volume`'s discipline about staying within one resource's
lifecycle.

**Idempotency** — Provider-existence and role-existence are both checked
independently and each individually idempotent (provider by URL match,
role via the existing `iamRoleStep` shape); the trust-policy reconcile is
inherently idempotent (same whole-document-replace property as
`rotate-role-permissions`).

**Determinism** — Single provider (shared across an account, so "single"
here means "ensured, not necessarily created by this run"), single role,
single trust-policy document per run.

**Ordering** — No dependency on the GitHub-side repo needing to exist
first for the AWS-side setup to succeed (the `sub` string is just a
string AWS doesn't validate against a live GitHub API — a real
misconfiguration, e.g. wrong repo name, only surfaces later when a
workflow run actually attempts `AssumeRoleWithWebIdentity` and AWS
rejects the mismatched claim). This task's `verify()` therefore cannot
confirm the GitHub side actually works end-to-end without triggering a
real workflow run — flagged as an inherent verification boundary, same
class as `resize-ebs-volume`'s filesystem-extension boundary.

**verify()** — Confirms the OIDC provider exists with the expected
`ClientIDList`, and the role's live trust policy (`GetRole`) matches the
desired document field-for-field. Does **not** confirm a real GitHub
Actions run can successfully assume the role — that would require
dispatching a workflow (task 10) configured to attempt the assumption,
which this plan notes as a natural, optional composition (a caller could
chain `trigger-workflow-dispatch` against a dedicated smoke-test workflow
after this task, with `waitForCompletion: true`, to get a real end-to-end
confirmation) but does not build automatically, since forcing every apply
of this task to also run a live workflow would be a surprising, possibly
costly side effect.

**Configurable params** — GitHub owner/repo, `scopeType: "branch" |
"environment"`, branch name or environment name, `allowAnyRefOrEnvironment:
boolean` (default `false`), AWS role name, list of permission-policy ARNs
to attach, `roleDescription`.

**Step decomposition** — Two composed steps sharing one integration
(mirroring `create-storage-s3-integration`'s own AWS-role-plus-something-
else shape): the OIDC-provider-and-role-existence step, and the
trust-policy-and-policy-attachment reconcile step — both live in this
task's own `steps/` folder since the trust-policy-construction logic
(`sub`/`aud` string building) is specific to this integration and not
shared elsewhere, while the underlying `iamRoleStep`/`iamAttachRolePolicyStep`/
`update-trust-policy` mechanics are reused from the existing shared
module and `aws/iam/role` integrations respectively. `resource()` reports
`{ type: "aws_iam_oidc_role", attributes: { providerArn, roleArn,
githubRepo, scope } }`.

### Sanity check

The `sub` claim format (`repo:OWNER/REPO:ref:refs/heads/BRANCH` and the
`:environment:NAME` variant) and the `aud=sts.amazonaws.com` convention
are both directly off the fetched AWS OIDC-for-GitHub-Actions docs. The
thumbprint-no-longer-required claim is flagged explicitly as the single
lowest-confidence fact in this whole document — AWS's OIDC thumbprint
handling for well-known providers has changed over time, and whoever
builds this should re-verify against the current AWS SDK's
`CreateOpenIdConnectProvider` behavior (some SDK versions still require a
`ThumbprintList` parameter to be present, even if AWS no longer uses it
for validation against GitHub's actual certificate) before shipping this
without a thumbprint field. The `allowAnyRefOrEnvironment` default-`false`
stance is a deliberate security-first choice worth confirming with
reviewers, same category of judgment call as `pruneUnmanagedTags`'s
default and `assign-elastic-ip`'s `AllowReassociation=false`.

---

## 14. sync-secrets-manager-to-github-secrets (AWS + GitHub combined)

The second combined task: takes secret values that already live in AWS
Secrets Manager (this project's existing trust boundary for
credentials — matching how `rotate-access-key`/`rotate-user-key-pair`
already treat "the secret's authoritative home" as a first-class design
question) and pushes copies into GitHub Actions repo or environment
secrets, so a workflow can consume them without either duplicating a
manual copy-paste step or granting the workflow direct
`secretsmanager:GetSecretValue` IAM permissions (a real, common
alternative this task's README should mention as a competing design —
this task exists for callers who specifically want GitHub-native secrets,
e.g. for use with actions that only read `secrets.*` context, not for
callers who could instead just grant the OIDC role from task 13 read
access to Secrets Manager directly).

**check()** — Write-blind on **both** ends now: Secrets Manager's
`GetSecretValue` can read the source value (real, unlike GitHub), but
this task's `check()` should not call `GetSecretValue` on every plan
just to compare — doing so would mean every `ferry plan` silently reads
a live secret value into process memory even when nothing needs to
change, a real credential-hygiene concern (least-privilege, and avoiding
unnecessary secret exposure in logs/memory) worth calling out plainly.
Instead, `check()` compares **metadata only**: Secrets Manager's
`DescribeSecret` returns a `VersionId`/`LastChangedDate` for the current
value; this task stores the `VersionId` it last synced (as a tag on the
Secrets Manager secret itself, e.g. `ferry:last-synced-version`, or in
`ctx.outputs` from the prior run — this plan picks the **tag**, since
`ctx.outputs` isn't guaranteed to persist across separate CLI invocations
the way a resource tag does, matching why `create-ebs-snapshot`/
`create-ami-from-instance` use tags rather than relying on ctx-level
state for cross-run identity). Current `VersionId` matches the tagged
`ferry:last-synced-version` → `"exists"` (source hasn's changed since
last sync — skip re-encrypting and re-pushing, avoiding the same
needless-churn concern task 5 flags for its own `FORCE_ROTATE=false`
default). Mismatch (or no tag yet) → `"missing"`.

**reconcile()** — N/A; this is create-or-skip keyed on the version tag,
not always-reconcile — deliberately, for the least-privilege reason above
(only touch the live secret value when the version comparison says it's
actually changed).

**create()** —
1. `secretsmanager:GetSecretValue` — only now, once `check()` has already
   established the source changed. Read the plaintext value.
2. Same sealed-box-encrypt-and-PUT flow as task 5/12 (shared `secrets.ts`
   functions) against the target GitHub scope (repo or environment
   secret, per params).
3. `secretsmanager:TagResource` on the source secret, setting
   `ferry:last-synced-version` to the `VersionId` just read — this is the
   step that makes the next run's `check()` a clean skip.
4. The plaintext value is held only in local process memory for the
   duration of this step and is never written to `ctx.outputs`,
   `resource()`, or any log line — same secret-hygiene discipline as
   every other secret-touching task in this project.

**rollback()** — Same write-blind limitation as task 5's rollback (the
GitHub-side prior value, if any, was never readable) — additionally,
this task's rollback should **not** revert the `ferry:last-synced-
version` tag on the Secrets Manager side either, since the source secret
itself was never modified by this integration (only read) — rollback
here is narrower than task 5's: remove the version-sync tag (so the next
run re-detects a "needs sync" state rather than incorrectly believing a
rolled-back GitHub secret is still in sync) and log the same "prior
GitHub-side value cannot be restored" warning task 5 logs.

**Idempotency** — The version-tag comparison is the load-bearing
mechanism (same role `ClientToken` plays for `launch-instance`,
`ferry:integration-id` tags play for the EBS-snapshot/AMI tasks) — a
re-run against an unchanged source secret is a clean skip without ever
touching the plaintext value a second time.

**Determinism** — Single source secret, single destination GitHub
secret, per run — a caller wanting to fan this out across N secrets runs
N instances (same granularity stance as task 5).

**Ordering** — Depends on the source Secrets Manager secret already
existing (out of scope for this plan — Secrets Manager secret creation
isn't one of the 12 `aws/ec2`/`aws/iam` tasks already built, and isn't
added here either, staying scoped) and the GitHub repo/environment
already existing (task 1 / task 11).

**verify()** — Confirms the GitHub-side secret's `updated_at` is at or
after this run's sync timestamp (same shallow confirm as task 5 — cannot
confirm the *value* matches, write-blind on the GitHub side) **and**
confirms the Secrets Manager tag was written successfully
(`DescribeSecret` shows `ferry:last-synced-version` matching the version
just synced) — this half genuinely is verifiable, unlike the GitHub half.

**Configurable params** — AWS secret ARN/name, target GitHub scope
(`repo` | `environment`), owner/repo, environment name (if scoped),
target GitHub secret name (may differ from the Secrets Manager secret's
own name).

**Step decomposition** — One step, composing the shared `secrets.ts`
GitHub functions with a small local `steps/secrets-manager-read.ts` for
the AWS-side read/tag logic (AWS Secrets Manager read/tag isn't reused
anywhere else in this project yet, so it stays local per the "single-
consumer logic stays local" rule — a second AWS+GitHub or AWS-only task
needing the same read/tag pattern would be the trigger to promote it into
`src/providers/aws/secretsmanager.ts`, per the project's existing
"two bespoke copies are fine, a third gets promoted" convention).
`resource()` reports `{ type: "github_actions_secret", attributes:
{ owner, repo, name, sourceSecretArn, syncedVersionId } }` — again
excluding the value itself.

### Sanity check

This task's central judgment call — comparing Secrets Manager
`VersionId` via a tag rather than reading the value on every `check()` —
is a deliberate least-privilege/hygiene decision, not an AWS or GitHub
API constraint; an alternative, simpler design would just always read
and always re-push (accepting the read-on-every-plan cost, same as
task 5's `FORCE_ROTATE` default-false debate), and that tradeoff should
be confirmed with reviewers before building, since "read the secret on
every plan" is a meaningfully different security posture than "read the
secret only when a version actually changed." The overall composition
pattern (shared GitHub `secrets.ts` + a new, currently-local AWS-side
read/tag helper) directly follows this project's already-established
share-vs-local discipline rather than inventing a new rule for the
combined-provider case.

---

## Summary: what's new here vs. the existing aws/s3, aws/iam, aws/ec2, snowflake plans

- New provider module `src/providers/github/` (client, repos, secrets,
  collaborators, webhooks, branch-protection) — same shape as
  `aws/iam.ts`/`aws/ec2.ts`/`snowflake/objects.ts`.
- 12 pure-GitHub tasks (1–12) covering repo lifecycle, access control
  (collaborators, branch protection, deploy keys), CI configuration
  (secrets at repo/org/environment scope, workflow enable/disable/
  dispatch), and the two structurally novel patterns this provider
  introduces to the project: **write-blind secrets** (task 5's shape,
  reused by 6/12/14) and **non-unique, fuzzy-identity resources**
  (task 8's webhook shape — the one true structural weak point across
  this entire project's `check()` design so far).
- 2 combined AWS+GitHub tasks (13, 14) that compose existing
  `aws/iam` shared factories with the new `github` provider module in a
  single integration each — the OIDC-trust-federation task (13, the
  standard secretless-CI-credentials pattern) and the Secrets-Manager-
  to-GitHub-secrets sync task (14, a least-privilege-motivated one-way
  sync) — both explicitly designed to reduce or eliminate the need to
  ever put a static AWS access key into a GitHub secret in the first
  place, tying this plan back to this project's own `create-access-key`/
  `rotate-access-key` tasks as the alternative they're meant to make
  unnecessary for CI use cases specifically.
