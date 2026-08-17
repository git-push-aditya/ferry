# snowflake — Implementation Plan

Grounded implementation plan for 14 Snowflake user/role/warehouse/grant integrations for
Ferry, following the conventions already established by
`integrations/snowflake/create-storage-s3-integration` and the AWS S3 integrations
(`integrations/aws/s3/*`). English-language algorithm steps only — no code.

Ferry conventions used throughout (see `src/core/define.ts`, `src/core/engine.ts`):

- `check()` is read-only, three-valued (`missing` / `exists` / `conflict`), and runs for
  every step before any mutation — including under `--dry-run`. `conflict` aborts the
  whole run before anything is touched.
- `create()` only runs when `check()` returned `missing`. `reconcile()` runs whenever it
  is defined UNLESS `create()` ran instead — i.e. every non-"missing", non-"skip" pass
  through an existing resource goes through `reconcile()`.
- `rollback()` is registered only for steps that actually ran (`create` or `reconcile`);
  a step that found its resource already present and did nothing is never unwound.
  Rollback is LIFO across the steps that ran this run.
- `resource()` reports a `ResourceRef { type, name, attributes }` for the run registry —
  only for steps that changed something durable.
- `retryWithBackoff` / `pollUntil` (`src/core/wait.ts`) are the sanctioned helpers for
  eventual-consistency waits and confirmation polling; no ad hoc `sleep`-and-hope.
- Snowflake access goes through `snowflakeClients(ctx).connection()` →
  `conn.runQuery(sql)` (`src/providers/snowflake/client.ts`), with `SHOW ... LIKE`
  read via `showMatchesExactly`/`showsExactly` (underscore-as-wildcard gotcha) and
  `DESC ...` read via `descProperties` (`src/providers/snowflake/ddl.ts`).
- Snowflake `GRANT` statements (role-to-user, role-to-role, privilege-on-object) are
  naturally idempotent and safely re-runnable — re-granting an already-held grant is
  not an error. This maps cleanly onto Ferry's "always-reconcile, self-idempotent"
  pattern (as used by `steps/trust-policy.ts` and `steps/storage-integration.ts`'s
  `ALTER ... SET` path): a grant step can treat `check()` as informational only and
  simply re-issue the `GRANT` every run, since the underlying SQL is idempotent by
  construction — no diffing is needed to make that safe.
- For destructive verbs (`REVOKE`, `DROP`, `ALTER USER SET DISABLED = TRUE`), Ferry's
  idiom is the "inverted create-or-skip": `check()` reports `missing` when the
  privilege/grant/user is *already gone* (nothing to do → `exists` in the create/skip
  sense is inverted to mean "already achieved"), matching the pattern in
  `delete-bucket-with-transfer/steps/transfer.ts`, where `check()` reads "source already
  deleted" as `exists` (target state achieved, skip) and "source still present" as
  `missing` (the destructive action still needs to run, and Ferry's engine will call
  `create()` for it). This document follows that same inversion for every
  revoke/disable/drop task below.

Facts about Snowflake SQL/API behavior below were verified against docs.snowflake.com
(fetched 2026-08-15); see the citations under each task's Sanity check where a claim
required verification.

## 1. onboard-developer-staging

**check()** — three independent sub-checks feed one plan step each (this is a composed
integration of shared step factories, not one step — see Step decomposition below):
(a) does `SHOW USERS LIKE '<username>'` return an exact name match (`showMatchesExactly`)
— `exists` if so, `conflict` if a user with that exact name exists but its `EMAIL`
or `TYPE` property doesn't match what this run expects (protects against silently
reusing/mutating an identity that belongs to someone/something else); (b) does
`SHOW ROLES LIKE '<role>'` show the target role already exists — if not, `conflict`
(this integration does not create roles for a developer on the fly; `create-role` is a
separate, deliberate task — see Ordering); (c) is the given public key already present
in `RSA_PUBLIC_KEY` for that user (relevant on re-run after a partial failure).

**reconcile()** — N/A for the create-user step (uses `create()`); the role-grant and
key-registration sub-steps use the always-reconcile grant pattern:
1. `CREATE USER IF NOT EXISTS <username> EMAIL = '<email>' DISPLAY_NAME = '<name>'
   DEFAULT_ROLE = '<role>' MUST_CHANGE_PASSWORD = FALSE TYPE = PERSON` (only in
   `create()`, gated on `missing`).
2. `ALTER USER <username> SET RSA_PUBLIC_KEY = '<pem-body-no-headers>'` — always
   reconciled (self-idempotent: setting the same key twice is a no-op mutation).
3. `GRANT ROLE <role> TO USER <username>` — always reconciled, per the idempotent-grant
   pattern.
4. Read back `SHOW GRANTS TO USER <username>` to confirm the role landed, and
   `DESC USER <username>` to confirm `RSA_PUBLIC_KEY_FP` is non-empty (confirms the key
   parsed, since Snowflake computes and stores a fingerprint only for a key it accepted).

**rollback()** — if the user was created this run (`create()` ran): `DROP USER
IF EXISTS <username>` (acceptable here specifically because the user has no
prior history to lose — it was created and failed verification within the same run;
see task 9 for why `DROP` is *not* the default once a user has any real history).
If the user pre-existed (this run only added the role grant / key), roll back only
those additions: `REVOKE ROLE <role> FROM USER <username>` and `ALTER USER <username>
UNSET RSA_PUBLIC_KEY` (captured "was RSA_PUBLIC_KEY previously set, and to what" before
mutating, exactly as `storage-integration.ts` captures prior state before an `ALTER`).

**Idempotency** — safe to re-run after any partial failure: `CREATE USER IF NOT EXISTS`,
the key `ALTER USER SET`, and the role `GRANT` are all naturally idempotent.

**Determinism** — the three sub-steps (user, role grant, key) have a fixed order because
the grant and key `ALTER` both require the user to already exist; order among the grant
and key steps relative to each other is not load-bearing and could run in either order,
but a fixed order (user → role → key) is kept for a single deterministic plan listing.

**Ordering** — depends on the target role already existing (a real precondition, not a
cycle: run `create-role` first if the role is new). This task is intentionally a
**bundle**, not duplication: onboarding a developer always needs all three actions
together, and a human operator should not be able to run "grant role" against a user
that doesn't exist yet. The three actions should be implemented as calls into the same
shared step factories that `grant-role-to-user` (task 7) and `add-public-key-to-existing-user`
(task 3) use — e.g. a `snowflakeUserStep`, `snowflakeRoleGrantStep`, and
`snowflakePublicKeyStep` factory, analogous to how `s3BucketStep`/`s3PrefixMarkerStep`
are shared factories reused by multiple AWS integrations. Bundling composes those
factories in one integration folder; it is not a separate reimplementation of them.

**verify()** — live check: `SHOW GRANTS TO USER <username>` includes the role row;
`DESC USER <username>` shows a non-empty `RSA_PUBLIC_KEY_FP`. If the org's process
requires the user actually be able to authenticate, a stretch verification opens a
throwaway JWT-authenticated connection with the registered key and runs `SELECT 1` —
optional, since it requires materializing the matching private key in the run
environment, which most orgs will not want to do inside an onboarding automation.

**Configurable params** — `SF_USERNAME`, `SF_EMAIL`, `SF_DISPLAY_NAME`, `SF_ROLE`,
`SF_RSA_PUBLIC_KEY` (PEM, body only). Credentials (staging account identifier,
admin auth) come from the root `.env`, never from folder params.

**Step decomposition** — three steps via shared factories (user, role grant, key), not
one monolithic step: each has independent identity and independent rollback (a key can
be un-set without dropping the user; a role can be revoked without touching the key).
This mirrors the S3 pattern of one step per independently-identified resource, unlike
`transfer-and-delete-source`, which is deliberately one step because it aggregates many
objects with no independent per-object rollback identity.

**Sanity check** — Verified via docs.snowflake.com/en/sql-reference/sql/create-user that
`EMAIL`, `DISPLAY_NAME`, `DEFAULT_ROLE`, `TYPE`, and `RSA_PUBLIC_KEY` are all real
`CREATE USER`/`ALTER USER` properties. One real open question: `CREATE USER IF NOT EXISTS`
combined with then unconditionally `ALTER`-ing `DEFAULT_ROLE`/`RSA_PUBLIC_KEY` means a
user that already existed for an unrelated reason (name collision) will get silently
mutated unless `check()`'s conflict sub-check (matching `EMAIL`/`TYPE`) is enforced
strictly — this is called out explicitly above and must not be weakened.

## 2. onboard-developer-prod

**check() / reconcile() / rollback() / Idempotency / Determinism / verify() /
Step decomposition** — identical in every mechanical respect to task 1. The SQL, the
step factories, and the rollback semantics do not change between staging and prod.

**Ordering** — same precondition (target role must already exist in the prod account),
plus one additional structural fact confirmed from docs.snowflake.com/en/user-guide/admin-account-identifier
and Snowflake's own guidance on environment separation: **staging and production being
"separate accounts" means literally separate Snowflake accounts**, each with its own
account identifier/URL and its own independent set of users, roles, and admin
credentials. There is no shared identity space between them. Consequently this is
**not safely modeled as a param toggle** (e.g. `SF_ENV=prod`) on top of one credential
set — it requires a genuinely separate root `.env` credential set (a distinct
`SNOWFLAKE_ACCOUNT`, and very likely a distinct `SNOWFLAKE_USERNAME`/key-pair with
prod-scoped `ACCOUNTADMIN`-equivalent rights) and, in Ferry's terms, a **separate
integration folder** (`onboard-developer-prod`, not a parameter on
`onboard-developer-staging`), exactly as this task list already treats them as two
distinct top-level tasks. This also gives the org a hard control point: the prod
folder's root `.env` and approval path can require a different reviewer/credential
than staging's, which a single parameterized integration could not enforce.

**Configurable params** — same shape as task 1. Additionally, the org's phase-2 process
may require an extra `SF_APPROVAL_TICKET` or similar param purely for the audit trail
in the report — optional, org-specific, not load-bearing for Ferry's mechanics.

**Sanity check** — Confirmed separate-accounts-per-environment is Snowflake's documented
recommended pattern, not an assumption. The genuine ambiguity flagged in the prompt is
resolved in favor of "two folders, two credential sets" rather than "one folder, one
param" — recorded here as a deliberate design decision, not asserted as the only
possible one. Orgs using Snowflake's newer "Organization accounts"/replication features
to run staging and prod as linked accounts under one org would need a different
model; this plan assumes the more common fully-separate-account pattern the task
description itself implies ("separate prod account... distinct approval/role path").

## 3. add-public-key-to-existing-user

**check()** — `SHOW USERS LIKE '<username>'` must match exactly (`conflict` if absent —
this task never creates a user; see Ordering). Then `DESC USER <username>` to read
current `RSA_PUBLIC_KEY` and `RSA_PUBLIC_KEY_2`. If the target slot (parameter-selected
or auto-selected — see reconcile step 1) already holds exactly the given key, report
`exists` (no-op). Otherwise `missing` in the inverted sense used for always-reconcile
mutations — i.e. this step always reconciles rather than gating on a hard missing/exists
binary, matching `storage-integration.ts`'s reconcile path.

**reconcile()** —
1. Read both `RSA_PUBLIC_KEY` and `RSA_PUBLIC_KEY_2` via `DESC USER`. If the caller did
   not pin a slot explicitly, pick whichever of the two is currently empty; if both are
   occupied, this is a real conflict (Snowflake has exactly two slots — confirmed below)
   and the step must fail loudly rather than silently overwrite a key that might still
   be in active use elsewhere — this is precisely the scenario `rotate-user-key-pair`
   (task 4) is designed to handle deliberately, not something this task should do as a
   side effect.
2. `ALTER USER <username> SET RSA_PUBLIC_KEY_2 = '<pem-body>'` (or `RSA_PUBLIC_KEY` if
   that's the empty slot) — capture the prior value of that slot (empty, in the normal
   path) before mutating.
3. Read back `DESC USER` to confirm the corresponding `_FP` fingerprint field changed
   and is non-empty.

**rollback()** — `ALTER USER <username> UNSET RSA_PUBLIC_KEY_2` (or whichever slot was
written), restoring the prior value if the slot was non-empty (should not happen on the
normal path, but the prior value is still captured defensively) or unsetting it if it
was previously empty.

**Idempotency** — re-running with the same key against the same slot is a no-op
mutation (SET to the same value again). Re-running against a now-different empty slot
because a previous run partially completed is handled by step 1's re-read.

**Determinism** — single step; no ordering ambiguity internally.

**Ordering** — depends on the user already existing (real precondition — `conflict` if
missing, this task never creates a user). Independent of `onboard-developer-*`; this is
the task the lead runs standalone with their elevated role, per the task description.

**verify()** — `DESC USER <username>` shows the new key's fingerprint in the slot that
was written.

**Configurable params** — `SF_USERNAME`, `SF_RSA_PUBLIC_KEY`, optional
`SF_KEY_SLOT` (`primary` | `secondary`) to pin a slot explicitly instead of
auto-selecting the empty one.

**Step decomposition** — one step; single resource, single mutation, single rollback
target.

**Sanity check** — Verified on docs.snowflake.com/en/sql-reference/sql/create-user and
alter-user that a Snowflake user has exactly two RSA public key slots
(`RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2`), each with its own fingerprint property
(`RSA_PUBLIC_KEY_FP`/`RSA_PUBLIC_KEY_2_FP`) — this is the mechanism that makes
zero-downtime rotation possible and is exactly what task 4 depends on. Structural
concern worth flagging: Snowflake docs also describe a newer, separate mechanism —
named key pairs via `ALTER USER ... ADD KEY PAIR` / `ROTATE KEY PAIR`, which supports
per-key expiration and a built-in 24-hour overlap window during rotation. This plan
uses the older `RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2` property mechanism throughout
(tasks 3-4) because it is simpler to check/reconcile/rollback with plain `DESC USER`
reads, but a real implementation should confirm with the org which mechanism their
Snowflake edition/policy expects before committing to one.

## 4. rotate-user-key-pair

**check()** — `DESC USER <username>` to read current `RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2`
and their fingerprints. `conflict` if the user doesn't exist. Otherwise always treated
as needing reconciliation (rotation is an action, not a state converged toward) —
`missing` in the always-reconcile sense.

**reconcile()** — the genuinely zero-downtime sequence, using the two verified key
slots so a client mid-session (or one that hasn't yet refreshed the new key into its
config) never sees an auth gap:
1. Read the currently active slot (whichever of `RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2` is
   populated and in current use — tracked from the last run's output if available,
   otherwise inferred as "the non-empty one" or, if both are populated, the one NOT
   passed as `SF_PRIOR_PUBLIC_KEY` param for disambiguation).
2. Write the brand-new public key into the *other*, currently-unused slot:
   `ALTER USER <username> SET RSA_PUBLIC_KEY_2 = '<new-pem>'` (assuming slot 1 is
   active) — the old key in slot 1 remains valid and unchanged throughout this step, so
   any client still authenticating with the old key continues to work uninterrupted.
3. Read back `DESC USER` to confirm the new key's fingerprint is present in slot 2.
4. This is the deliberate hand-off point: the new key is now live in parallel with the
   old one. Ferry's run itself does not "wait for clients to switch" (that's outside
   Ferry's scope — Ferry provisions/rotates infrastructure, it does not orchestrate
   client rollout) — the report emitted at the end of this run instructs the operator
   that both keys are currently valid and gives a follow-up command (or, if the org
   wants it in one shot, a parameter that also runs step 5 immediately).
5. Once the new key is confirmed in use (either immediately, if the caller passed a
   `SF_ROTATE_IMMEDIATELY` param, or in a distinct later invocation of this same
   integration against the same user), unset the old slot:
   `ALTER USER <username> UNSET RSA_PUBLIC_KEY` — deactivating the old key.

**rollback()** — if this run only reached step 3 (new key written, old key not yet
unset): `ALTER USER <username> UNSET RSA_PUBLIC_KEY_2` (undo the new-key write; the old
key was never touched, so nothing else to restore). If this run also completed step 5
(old key unset) before something later failed (e.g. verify()): restore the prior
`RSA_PUBLIC_KEY` value captured before step 5 ran.

**Idempotency** — re-running mid-rotation (new key present in one slot, old key still
present in the other) is safe: step 2 is a no-op re-set of the same value, step 5's
unset is likewise idempotent (`UNSET` on an already-empty property does not error).

**Determinism** — the two-phase order (write-new-then-later-unset-old) is a hard
invariant; collapsing it to drop-then-add would reintroduce exactly the downtime
this task exists to avoid.

**Ordering** — depends on the user already existing. Independent of, and safely
composable with, task 3 (adding an *additional* key to an already-provisioned user is a
different, non-rotating operation — task 3 explicitly conflicts if it finds both slots
already full, deferring the decision to this task).

**verify()** — `DESC USER` shows the new key's fingerprint present, and (if step 5 ran)
the old key's fingerprint is now empty in what was its slot.

**Configurable params** — `SF_USERNAME`, `SF_NEW_RSA_PUBLIC_KEY`, optional
`SF_ROTATE_IMMEDIATELY` (bool, default false — conservative default matches the
"never silently do the irreversible half" principle used elsewhere in this doc).

**Step decomposition** — one step covering the full rotation state machine; splitting
"write new key" and "retire old key" into two separately-scheduled Ferry steps within
one run doesn't fit the model well since step 5 may legitimately run in a wholly
separate invocation, hours or days later — that later invocation is simply this same
integration run again, whose `check()`/`reconcile()` naturally detects "new key present,
old key still present" and proceeds to step 5.

**Sanity check** — Verified per docs.snowflake.com/en/user-guide/key-pair-auth and
alter-user that the two-slot mechanism is real and is Snowflake's documented way to
achieve rotation without downtime, and separately that named key pairs
(`ROTATE KEY PAIR`) provide a *different*, also-real, built-in 24-hour overlap window.
This task deliberately implements the manual two-slot version per the prompt's
instruction, but flags that if the org later adopts named key pairs, this task's
`reconcile()` collapses into a single `ROTATE KEY PAIR` call and most of the
manual state-tracking above becomes unnecessary — worth a follow-up decision, not
a blocker now.

## 5. update-user-role

**check()** — `SHOW GRANTS TO USER <username>` to read currently granted roles.
`conflict` if the user doesn't exist. If the target role is already granted (and, when
`SF_REMOVE_PRIOR_ROLE` is set, the prior role is already absent), report `exists`.
Otherwise proceed as an always-reconcile grant-change.

**reconcile()** —
1. `GRANT ROLE <new_role> TO USER <username>` — idempotent, safe to always issue.
2. If a `SF_PRIOR_ROLE` param is given and `SF_REMOVE_PRIOR_ROLE` is true: capture that
   the prior role was granted (from step 0's `SHOW GRANTS TO USER` read) and
   `REVOKE ROLE <prior_role> FROM USER <username>`.
3. Optionally, if the new role should become the user's session default:
   `ALTER USER <username> SET DEFAULT_ROLE = <new_role>` — capture the prior
   `DEFAULT_ROLE` value from `DESC USER` first.

**rollback()** — `REVOKE ROLE <new_role> FROM USER <username>` (only if this run granted
it — always true here since this task's whole point is granting the new role); if the
prior role was revoked this run, re-`GRANT` it back; if `DEFAULT_ROLE` was changed,
`ALTER USER SET DEFAULT_ROLE = <captured prior value>`.

**Idempotency** — every sub-action is a plain idempotent grant/revoke/set; re-running is
safe at any interruption point.

**Determinism** — grant-new before revoke-prior is the safer order (a developer is never
momentarily role-less mid-run); this ordering is a soft preference, not a hard
invariant, but is kept fixed for predictability.

**Ordering** — depends on both the user and the new role already existing (`conflict` on
either being absent — this task assumes `create-role`, task 6, already ran for a new
role). This is a thin wrapper around the same shared `grant-role-to-user` /
`revoke-role-from-user` step factories as tasks 7 and 8 — implemented by composing
them, not reimplementing the SQL.

**verify()** — `SHOW GRANTS TO USER <username>` includes the new role and (if
requested) excludes the prior role; `DESC USER` shows the expected `DEFAULT_ROLE` if
that was changed.

**Configurable params** — `SF_USERNAME`, `SF_NEW_ROLE`, optional `SF_PRIOR_ROLE`,
optional `SF_REMOVE_PRIOR_ROLE` (bool), optional `SF_SET_AS_DEFAULT` (bool).

**Step decomposition** — one step composing grant + optional revoke + optional
default-role set, all against a single user; not split further since they share one
`SHOW GRANTS`/`DESC USER` read and one rollback unit of work.

**Sanity check** — `GRANT ROLE`/`REVOKE ROLE` syntax confirmed via
docs.snowflake.com/en/sql-reference/sql/grant-role; the docs do not explicitly state
idempotency of a duplicate `GRANT ROLE`, so this plan's claim of idempotency rests on
general Snowflake grant-statement behavior (also un-stated explicitly for
object-privilege grants in task 12) rather than an explicit doc citation — flagged
here honestly as inferred, not guaranteed; recommend a one-time smoke test against a
real account before relying on it in production automation.

## 6. create-role

**check()** — `SHOW ROLES LIKE '<role>'` via `showMatchesExactly`. `exists` if the exact
name is present (no ownership/`conflict` concept for roles the way there is for
S3-bucket-owned-by-another-account — Snowflake roles are account-scoped and any exact
name match is unambiguously "this role"). Otherwise `missing`.

**create()** — `CREATE ROLE IF NOT EXISTS <role> COMMENT = '<purpose>'`, then issue the
role's initial privilege grants (see reconcile below — the initial grant set is applied
in `create()` too, not deferred, so a freshly created role is never left with zero
privileges).

**reconcile()** — for a role that already existed, re-issue the same declared privilege
grants unconditionally (idempotent `GRANT ... TO ROLE`), rather than diffing against
whatever the role currently has — consistent with Ferry's "check() is a shallow
presence probe, not drift detection" principle from `define.ts`. This adds any
privileges declared in params that the role doesn't yet have; it never revokes
privileges the role has that aren't declared (removing an undeclared grant is `task 8`'s
job, run deliberately, not an implicit side effect of `create-role`).

**rollback()** — if the role was created this run: `DROP ROLE IF EXISTS <role>`
(safe — nothing had used it yet, since this is the same run that created it). If the
role pre-existed and this run only added grants via `reconcile()`: revoke exactly the
grants this run added (diffed against the pre-run `SHOW GRANTS OF ROLE`/`SHOW GRANTS TO
ROLE` snapshot captured before reconciling), never touching grants the role already
held.

**Idempotency** — `CREATE ROLE IF NOT EXISTS` plus idempotent grants make repeated runs
safe.

**Determinism** — grant order among the declared privilege list is not meaningful and
may run in any order; the create-then-grant order is a hard invariant (grants cannot
target a role that doesn't exist yet).

**Ordering** — no dependency on any other task in this list; frequently a prerequisite
*for* tasks 1, 2, 5, 7 (a role must exist before it can be granted).

**verify()** — `SHOW ROLES LIKE '<role>'` matches; `SHOW GRANTS TO ROLE <role>` includes
every privilege declared in params.

**Configurable params** — `SF_ROLE`, `SF_COMMENT`, and a list-shaped param for the
initial privilege set, e.g. `SF_GRANTS` as a JSON array of
`{ privilege, on: "DATABASE"|"SCHEMA"|..., objectName }` tuples.

**Step decomposition** — a **step factory** over the grants list is the right shape
here, mirroring `s3PrefixMarkerStep`/`s3BucketStep`'s factory pattern and this doc's
task 12 discussion: one `CREATE ROLE` step plus N generated `grantPrivilegeStep`
instances (one per declared grant), each independently checkable/rollback-able, rather
than looping inline inside a single step's `reconcile()` — this gives each grant its own
plan-line visibility (`[create] GRANT USAGE ON DATABASE ANALYTICS TO ROLE ...`) and its
own independent rollback if only some grants in the list succeed before a later one
fails.

**Sanity check** — `CREATE ROLE`/`SHOW ROLES`/`SHOW GRANTS TO ROLE`/`SHOW GRANTS OF ROLE`
all confirmed via docs.snowflake.com/en/sql-reference/sql/show-grants and the
CREATE ROLE reference. One structural concern: deciding the initial grant set inside
`create-role` itself (rather than leaving a bare role for `grant-database-schema-access`,
task 12, to populate afterward) blurs the line between "create a role" and "grant
access" — this plan resolves it by making the initial `SF_GRANTS` param optional (a
role with an empty grants list is a legitimate, common case — e.g. a role meant to be
composed later purely via `GRANT ROLE ... TO ROLE`), so `create-role` degrades cleanly
to "just create the role" when no grants are declared.

## 7. grant-role-to-user

**check()** — `SHOW GRANTS TO USER <username>` (or `SHOW GRANTS OF ROLE <role>`, either
read gets the same fact); `conflict` if either the user or the role doesn't exist
(`SHOW USERS LIKE`/`SHOW ROLES LIKE` both come back empty/non-matching). `exists` if the
role is already granted to that user; `missing` otherwise (in the always-reconcile
sense — this step, like the trust-policy/storage-integration steps, can equally just
always reconcile, since `GRANT ROLE` is idempotent; treating it as check-then-create is
mostly for a clean plan-phase message like `[create] grant DATA_ENGINEER to alice`).

**reconcile() / create()** — single statement: `GRANT ROLE <role> TO USER <username>`.

**rollback()** — `REVOKE ROLE <role> FROM USER <username>`, but **only if this run's
`check()` found it missing and thus this run actually granted it** — a grant that
pre-existed is never revoked on rollback (mirrors "a resource that already existed is
never rolled back" from `define.ts`).

**Idempotency** — trivially safe to re-run; `GRANT ROLE` on an already-held grant is a
no-op.

**Determinism** — single statement, nothing to order internally.

**Ordering** — real precondition on both the user (tasks 1/2/3) and the role (task 6)
already existing — `conflict`, not a silent create-on-the-fly, if either is missing.
This is the shared step factory that tasks 1, 2, and 5 compose into their own bundled
flows; it should be implemented once (e.g. `snowflakeRoleGrantStep` in
`src/providers/snowflake`) and imported everywhere a role-to-user grant is needed,
exactly as `iam-role`/`attach-policy` steps are shared AWS-side factories.

**verify()** — `SHOW GRANTS TO USER <username>` includes a row for `<role>`.

**Configurable params** — `SF_USERNAME`, `SF_ROLE`.

**Step decomposition** — one step; single resource (one grant edge), single rollback
unit.

**Sanity check** — `GRANT ROLE ... TO USER` syntax confirmed via
docs.snowflake.com/en/sql-reference/sql/grant-role. As with task 5, the docs don't
explicitly state that re-granting an already-held role is a no-op rather than an error;
this is treated in the plan as very likely true based on general Snowflake grant
semantics but should be smoke-tested once against a real account before depending on it
for the "always safe to re-run" claim.

## 8. revoke-role-from-user

**check()** — inverted create-or-skip, per this doc's stated convention: `SHOW GRANTS TO
USER <username>` — if the role is **not currently granted**, report that as the
already-achieved target state (`exists`, i.e. skip — nothing to revoke). If the role
**is** currently granted, report `missing` in the inverted sense (the revoke action
still needs to happen) so the engine routes to `create()`. `conflict` if the user
doesn't exist at all (nothing sensible to revoke against).

**create()** (the action slot Ferry routes to when `check()` says the revoke still needs
to happen) —
1. Capture that the grant existed (for rollback) via the `SHOW GRANTS TO USER` read
   already done in `check()`.
2. `REVOKE ROLE <role> FROM USER <username>`.
3. Read back `SHOW GRANTS TO USER <username>` to confirm the role row is gone.

**rollback()** — `GRANT ROLE <role> TO USER <username>` — restores exactly the grant
this run removed. (This is safe and simple specifically because a role grant carries no
other state — unlike `DROP USER`/task 9, revoking a grant loses nothing that can't be
trivially restored.)

**Idempotency** — re-running after the grant is already gone reads as `exists`/skip;
safe.

**Determinism** — single statement.

**Ordering** — depends on the user existing; does not require the role to still exist
(revoking a grant to a role that was since dropped is itself likely a no-op/error
Snowflake handles by simply having nothing to revoke — this task's `check()` should
treat "role doesn't exist" the same as "grant doesn't exist," i.e. `exists`/skip, not
`conflict`, since offboarding/rotation scenarios routinely run this after a role was
already cleaned up).

**verify()** — `SHOW GRANTS TO USER <username>` no longer includes `<role>`.

**Configurable params** — `SF_USERNAME`, `SF_ROLE`.

**Step decomposition** — one step.

**Sanity check** — `REVOKE ROLE` is the documented inverse of `GRANT ROLE` (same
reference page). The inverted-check design here is the same shape as
`delete-bucket-with-transfer`'s `transfer-and-delete-source` step (`check()` returns
`exists` when the destructive goal is already achieved) — consistent with this doc's
stated convention and worth keeping consistent across all revoke/drop/disable tasks
below for a reader scanning the whole document.

## 9. offboard-developer

**check()** — reads current state across one or both accounts (staging and/or prod,
per `SF_SCOPE` param — see Ordering): `SHOW USERS LIKE '<username>'`, and if present,
`DESC USER` for `DISABLED`, plus `SHOW GRANTS TO USER` for current roles, plus
`DESC USER` for `RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2`. Inverted create-or-skip: if the
user is already `DISABLED = TRUE` (default path) or already dropped (hard-delete path,
param-gated), with no roles granted and no keys set, report `exists`/skip. Otherwise
`missing` in the inverted sense — offboarding actions still need to run.

**create()** (routed to when offboarding is still incomplete) — **default path,
disable, not drop**:
1. Capture the full pre-offboarding snapshot (granted roles, both key slots, `DISABLED`
   value, `DEFAULT_ROLE`) into outputs — this is what makes the operation reversible.
2. `REVOKE ROLE <role> FROM USER <username>` for every role currently granted.
3. `ALTER USER <username> UNSET RSA_PUBLIC_KEY, RSA_PUBLIC_KEY_2` — removes both key
   slots so no lingering key-pair auth path remains even while the account object
   still exists.
4. `ALTER USER <username> SET DISABLED = TRUE` — per the verified semantics, this
   immediately aborts any running/scheduled queries for the user and locks them out;
   it does **not** delete the account, its query history, its ownership of any objects,
   or its historical grants (those are captured in the snapshot, but the account itself
   retains its full audit trail).
5. **Only if `SF_HARD_DELETE = true` is explicitly passed** (opt-in, not default):
   `DROP USER IF EXISTS <username>`. This is called out as a distinct, explicitly
   irreversible branch — see rollback() below.

**rollback()** —
- If only steps 2-4 ran (the default, disable-only path): re-`GRANT ROLE` each
  previously-held role back, `ALTER USER SET RSA_PUBLIC_KEY[/_2]` back to the captured
  prior values (or leave unset if they were empty before), and `ALTER USER SET
  DISABLED = FALSE`. Fully reversible — this is exactly why disable is the default.
- If step 5 (`DROP USER`) ran: **rollback cannot undo it.** Per Snowflake's own
  documentation, a dropped user cannot be recovered and must be recreated from scratch
  — Ferry's rollback contract can restore *state*, not *identity* (a recreated user is
  a new object with no history, ownership records, or query history preserved). The
  implementation must make this an explicit, loud limitation: `rollback()` for the
  hard-delete branch should recreate the user with the captured snapshot (name, email,
  role grants, keys) as a best-effort restoration and log a prominent warning that this
  is not a true undo, rather than silently pretending equivalence.

**Idempotency** — safe to re-run the disable path (re-revoking/re-unsetting/re-disabling
an already-offboarded user is a no-op). The hard-delete path is idempotent in the sense
that `DROP USER IF EXISTS` on an already-dropped user is a no-op, but is not something
worth "re-running" meaningfully.

**Determinism** — revoke-roles → unset-keys → disable → (optional) drop is a hard
invariant order: disabling first would abort the very queries this run's own revoke/
unset statements might be running under certain auth paths, and dropping before
capturing the snapshot would lose the information rollback needs.

**Ordering** — `SF_SCOPE` (`staging` | `prod` | `both`) determines whether this
integration composes one or two independent runs against the two separate account
credential sets described in task 2 — since staging and prod are fully separate
accounts, "both" is implemented as two sequential sub-runs (staging first, prod
second, or the reverse — order between them is not load-bearing) against two distinct
Snowflake connections, not a single query against one account.

**verify()** — for the disable path: `DESC USER` shows `DISABLED = TRUE`, `SHOW GRANTS TO
USER` returns no rows, both key slots empty. For the hard-delete path: `SHOW USERS LIKE
'<username>'` returns no match.

**Configurable params** — `SF_USERNAME`, `SF_SCOPE`, `SF_HARD_DELETE` (bool, default
**false**).

**Step decomposition** — one step per account scope (so `SF_SCOPE = both` produces two
plan-visible steps, one per account), each internally performing the numbered
sequence above as one atomic unit — not split further, since the revoke/unset/disable
sequence shares one before-snapshot and one rollback unit per account.

**Sanity check** — `DISABLED = TRUE` behavior (aborts running/scheduled queries, locks
out login) and `DROP USER` irreversibility (no `UNDROP`, "must be recreated") both
directly confirmed via docs.snowflake.com/en/sql-reference/sql/alter-user and
drop-user. The plan's choice to default to disable and gate hard-delete behind an
explicit param directly reflects the prompt's own instruction and Ferry's "rollback
can only undo what it can actually undo" principle — this is the one task in the
document where rollback is explicitly and honestly incomplete for a branch, rather
than glossed over.

## 10. create-warehouse

**check()** — `SHOW WAREHOUSES LIKE '<name>'` via `showMatchesExactly`. `exists` if
present; `missing` otherwise. No `conflict` case analogous to S3's cross-account bucket
ownership — Snowflake warehouses are account-scoped compute objects with no
external-ownership ambiguity.

**create()** — `CREATE WAREHOUSE IF NOT EXISTS <name> WAREHOUSE_SIZE = '<size>'
AUTO_SUSPEND = <seconds> AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE`
(`INITIALLY_SUSPENDED = TRUE` avoids burning compute credits at creation time before
anything is scheduled against it — a deliberate default, not an oversight).

**reconcile()** — not defined; a warehouse that already exists with the given name is
left as-is by this task (`skip`). Changing an existing warehouse's size/auto-suspend
settings is deliberately task 11's job, not an implicit side effect of re-running
`create-warehouse` — this avoids a `create-warehouse` re-run silently resizing a
production warehouse that another team is actively tuning.

**rollback()** — `DROP WAREHOUSE IF EXISTS <name>` (only registered when `create()` ran
this run — a pre-existing warehouse this task skipped is never dropped).

**Idempotency** — `CREATE WAREHOUSE IF NOT EXISTS` makes repeated runs safe.

**Determinism** — single statement.

**Ordering** — no dependency on other tasks in this list; frequently a prerequisite for
whatever query workloads or other integrations (e.g. the existing
`create-storage-s3-integration`, which needs `SNOWFLAKE_WAREHOUSE` in root
credentials) will run against it later.

**verify()** — `SHOW WAREHOUSES LIKE '<name>'` matches, and the reported
`size`/`auto_suspend` columns equal what was requested.

**Configurable params** — `SF_WAREHOUSE_NAME`, `SF_WAREHOUSE_SIZE`,
`SF_AUTO_SUSPEND_SECONDS`, optional `SF_AUTO_RESUME` (bool, default true).

**Step decomposition** — one step; single resource.

**Sanity check** — `CREATE WAREHOUSE`/`AUTO_SUSPEND`/`WAREHOUSE_SIZE` are standard,
uncontroversial Snowflake DDL properties; no ambiguity found. The deliberate
`skip`-rather-than-resize behavior on an existing warehouse is a scope decision worth
flagging explicitly (mirrors the S3 doc's `update-bucket-permissions` ACL-scope flag):
it means `create-warehouse` and `update-warehouse-size` (task 11) must both exist and
neither one silently subsumes the other.

## 11. update-warehouse-size

**check()** — `SHOW WAREHOUSES LIKE '<name>'`; `conflict` if it doesn't exist (this task
never creates one — real precondition on task 10). Read the current `size` column; if
it already equals the requested `SF_WAREHOUSE_SIZE`, report `exists`/skip. Otherwise
`missing` in the always-reconcile-mutation sense.

**reconcile()** —
1. Capture the current `WAREHOUSE_SIZE` (from the `SHOW WAREHOUSES` row read in
   `check()`) for rollback.
2. `ALTER WAREHOUSE <name> SET WAREHOUSE_SIZE = '<new_size>'` — per verified Snowflake
   behavior, this does not disrupt currently executing statements: running queries
   continue on their existing compute resources, and the new size takes effect only for
   statements that start after the resize completes. This is architecturally different
   from resizing an AWS EC2-backed resource, where a resize is disruptive to what's
   currently running — worth noting explicitly since a reviewer coming from the AWS
   side of this codebase might otherwise assume a maintenance-window-style precaution
   is needed here; it is not.
3. Optionally pass `WAIT_FOR_COMPLETION = TRUE` in the same `ALTER` statement (rather
   than a separate `pollUntil` loop) if the integration wants the run to block until
   the new compute is actually provisioned before `verify()` runs — recommended default,
   since without it `verify()` could read back the old size if it runs too soon after
   an async resize.

**rollback()** — `ALTER WAREHOUSE <name> SET WAREHOUSE_SIZE = '<captured prior size>'`.

**Idempotency** — safe to re-run; re-setting the same size is a no-op mutation.

**Determinism** — single statement; `WAIT_FOR_COMPLETION` (if used) makes the step's
completion deterministic relative to `verify()`.

**Ordering** — depends on the warehouse already existing (task 10).

**verify()** — `SHOW WAREHOUSES LIKE '<name>'` reports the new `size`.

**Configurable params** — `SF_WAREHOUSE_NAME`, `SF_WAREHOUSE_SIZE`, optional
`SF_WAIT_FOR_COMPLETION` (bool, default true — favors a deterministic `verify()` over a
faster but racier return).

**Step decomposition** — one step; single resource, single property mutation.

**Sanity check** — the near-instant, non-disruptive resize claim is directly confirmed
by docs.snowflake.com/en/sql-reference/sql/alter-warehouse: "the change doesn't impact
any statements... currently executing." This is the one place in the whole document
where Snowflake's architecture (multi-cluster, resize-by-reprovisioning rather than
resize-in-place) genuinely simplifies the Ferry step relative to the AWS EC2 analogy —
no need for a "drain connections first" precondition the way a stateful compute resize
elsewhere might need.

## 12. grant-database-schema-access

**check()** — for each declared `(database, schema?, privilege)` tuple: `SHOW GRANTS TO
ROLE <role>` (filtered to grants `ON DATABASE`/`ON SCHEMA` matching the target object);
`conflict` if the role or the target database/schema doesn't exist. `exists` if every
declared tuple is already granted; otherwise `missing` for the ones not yet granted (a
per-tuple state, since this is a step-factory task — see Step decomposition).

**reconcile() / create()** — per tuple: `GRANT <privilege> ON DATABASE <db>` or
`GRANT <privilege> ON SCHEMA <db>.<schema> TO ROLE <role>`. Idempotent; safe to always
issue regardless of the exact/inverted check outcome, matching this doc's stated
grant-idempotency convention.

**rollback()** — `REVOKE <privilege> ON {DATABASE|SCHEMA} <object> FROM ROLE <role>`,
only for the tuples this run actually granted (a pre-existing grant found by
`check()` as already-present is never revoked on rollback).

**Idempotency** — safe to re-run; re-granting an already-held privilege is expected to
be a no-op (see Sanity check below for the caveat on this).

**Determinism** — grant order across independent `(database, schema, privilege)` tuples
is not meaningful; each tuple's grant/revoke is independent.

**Ordering** — depends on the role (task 6) and the target database/schema already
existing — real preconditions, `conflict` if absent (this task does not create
databases or schemas).

**verify()** — `SHOW GRANTS TO ROLE <role>` includes every declared tuple.

**Configurable params** — `SF_ROLE`, and a list-shaped param, e.g. `SF_ACCESS_GRANTS` as
a JSON array of `{ privilege, level: "DATABASE"|"SCHEMA", database, schema? }`
tuples — this is the same list-of-independent-resources shape task 6 uses for its
initial grant set.

**Step decomposition** — **step factory**, one generated step per declared
`(privilege, object)` tuple, not one step looping over the list internally — for the
same reason as task 6: independent plan-line visibility per grant, and independent
rollback if some grants in a multi-database/multi-schema list succeed before a later
one fails (e.g. granting `USAGE` on three schemas where the third schema doesn't exist
yet should not force rolling back the two that already succeeded as a single bundled
unit — a step-factory naturally isolates that). The same generated-step function should
be the one task 6 also composes for its initial grant list, so there is exactly one
implementation of "grant privilege on database/schema to role."

**Sanity check** — `GRANT ... ON DATABASE`/`GRANT ... ON SCHEMA` syntax confirmed via
docs.snowflake.com/en/sql-reference/sql/grant-privilege. As flagged in tasks 5 and 7,
the docs do not explicitly state that re-granting an already-held object privilege is a
no-op rather than an error — this plan's reliance on grant idempotency across the whole
document rests on that inferred (not doc-cited) behavior, and is the single most
important fact worth a one-time empirical smoke test before treating any of these
"always safe to re-grant" claims as fully verified.

## 13. create-storage-integration (extend for read-only vs read-write scoping)

This task already exists as `integrations/snowflake/create-storage-s3-integration`
(`integration.ts`, `params.ts`, `steps/storage-integration.ts`,
`steps/trust-policy.ts`, etc.) and is fully implemented; this subsection describes
the extension for read-only vs read-write variants, not a from-scratch build.

**check()** — unchanged from the existing `storage-integration` step
(`showsExactly(conn, "INTEGRATIONS", name)`), plus a new read: `DESC STAGE <name>` (via
`descProperties`, already used for `DESC INTEGRATION`) to inspect whatever marks the
stage's intended access mode — realistically this is not a native Snowflake
stage/integration property (storage integrations and external stages don't have a
built-in "read-only" flag; scoping is enforced entirely on the AWS IAM side, and,
separately, via the SQL privileges granted on the stage object itself) — so the actual
"read-only vs read-write" distinction has to be implemented as **two different IAM
policy documents**, not two different Snowflake DDL branches. See reconcile below.

**reconcile()** — extends the existing `iam-policy` step
(`integrations/snowflake/create-storage-s3-integration/steps/iam-policy.ts`, referenced
via `policies/index.ts`) with a second policy document variant: the existing policy
already grants `GetBucketLocation`/`ListBucket` plus `Get`/`Put`/`DeleteObject` on the
prefix (per the README's existing table) — the read-write case. A new read-only variant
drops `Put`/`DeleteObject`, keeping only `GetBucketLocation`/`ListBucket`/`GetObject`.
The existing `storage-integration`/`trust-policy`/`stage` Snowflake-side steps are
unchanged — the scoping lives entirely in which IAM policy document
`iam-policy`/`attach-policy` writes, selected by a new `SF_ACCESS_MODE`
(`read-only` | `read-write`) param. Additionally, at the Snowflake SQL level, the
`GRANT USAGE ON STAGE <name> TO ROLE <role>` plus, for genuinely read-only access,
withholding `WRITE` privilege at the stage-privilege-grant level (relevant to whichever
role is meant to read from vs. write to the stage) reinforces the same scoping from the
Snowflake side, independent of the IAM policy — belt-and-suspenders, not redundant,
since IAM policy and Snowflake stage privileges are enforced by two different systems
and a misconfiguration in either alone should not silently grant unintended access.

**rollback()** — unchanged from the existing steps' rollback semantics (captured
prior IAM policy document / prior stage privilege state, restored on rollback,
exactly as `steps/trust-policy.ts` and `steps/storage-integration.ts` already do).

**Idempotency / Determinism / Ordering** — unchanged from the existing integration;
the circular-dependency step order documented in `integration.ts`'s own comment
(role placeholder trust → storage integration → `DESC INTEGRATION` → patch trust
policy) is untouched by this extension.

**verify()** — extends the existing live `COPY INTO` proof: for the read-write variant,
unchanged (a test CSV is written and cleaned up); for the read-only variant, the proof
must instead attempt a read of a pre-seeded test object and confirm a write attempt is
rejected (AWS `AccessDenied`) — proving the restriction is actually enforced, not merely
requested.

**Configurable params** — adds `SF_ACCESS_MODE` (`read-only` | `read-write`, default
`read-write` to match current behavior unchanged) to the existing `params.ts` schema.

**Step decomposition** — no new steps; `iam-policy.ts`'s existing policy-document
builder gains a second branch, selected by the new param, and a new
`stagePrivilegeStep` (or an extension of an existing grant step) enforces the SQL-side
half of the scoping.

**Sanity check** — Read `create-storage-s3-integration/integration.ts`, `README.md`,
`steps/storage-integration.ts`, and `steps/trust-policy.ts` in full. Confirmed the
existing implementation is read-write only (its IAM policy grants
`Get`/`Put`/`DeleteObject`) and that Snowflake storage integrations/stages have no
native read-only flag — the scoping genuinely has to live in the IAM policy document
plus stage-level SQL privileges, not in Snowflake DDL alone. This is a real design
addition, not a small parameter tweak, and should be reviewed against the existing
integration's test suite (any existing tests pinning the current IAM policy document's
exact shape will need updating once a second variant exists).

## 14. audit-user-access

**check()** — this is a **read-only reporting task with no mutation at all** — there is
no resource to create/reconcile/roll back. `check()` for its (single) step always
returns `exists` (nothing to converge toward; the "step" is entirely a read), which
means Ferry's engine always treats it as `skip` in the create/reconcile sense — the
actual work happens in a dedicated read path, not in `create()`/`reconcile()`. (This is
a deliberate exception to the normal check/create/reconcile shape, similar in spirit to
`desc-integration.ts` in the existing S3 integration, which also exists purely to read
values into `ctx.outputs` with no create/reconcile of its own.)

**reconcile()** — not applicable; see check() above. The actual data-gathering runs as
a `create()`-equivalent-but-always-runs read step (matching `desc-integration.ts`'s
"nothing — reads ... " row in the existing README's step table): for each requested
scope (staging, prod, or both):
1. `SHOW GRANTS TO USER <username>` — every role granted to the user.
2. For each such role, `SHOW GRANTS TO ROLE <role>` — every privilege/object the role
   itself carries, recursively for any role-to-role grants (`SHOW GRANTS OF ROLE
   <role>` shows what the role has been granted *to*, i.e. its parents/children —
   walked to build the full effective-access picture rather than just the first-level
   role list).
3. `DESC USER <username>` — account-level flags relevant to a review: `DISABLED`,
   `DEFAULT_ROLE`, `RSA_PUBLIC_KEY_FP`/`RSA_PUBLIC_KEY_2_FP` presence (has a key
   registered at all, without exposing the key itself).

**rollback()** — no-op; nothing was ever mutated.

**Idempotency** — trivially idempotent; a pure read, safe to run any number of times.

**Determinism** — the walk in step 2 (role → role's own grants → any parent roles) needs
a visited-set guard against role-hierarchy cycles (Snowflake role grants can form a
DAG that isn't necessarily a simple tree) so the traversal terminates deterministically.

**Ordering** — no dependency on other tasks; this is explicitly meant to be run
*before* any access-changing task (5, 7, 8, 9) as the "review before a change" step the
task description calls for. Composes two independent Snowflake connections (staging,
prod) when `SF_SCOPE = both`, exactly as task 9 does, for the same reason (separate
accounts, separate credentials).

**verify()** — for a pure-read task, `verify()` degrades to confirming the report was
actually populated (non-empty role list unless the user genuinely has zero roles, which
is itself a reportable finding) rather than proving a live functional effect the way
the S3 integration's `COPY INTO` does — there is no infrastructure behavior to prove
here, only that the read succeeded and returned a coherent shape.

**Configurable params** — `SF_USERNAME`, `SF_SCOPE` (`staging` | `prod` | `both`).

**Step decomposition** — one step per scope (staging / prod), each a pure read; the
`report()` function (already part of Ferry's `Integration<P>` contract per
`define.ts`) is where this task's real value shows up — a masked, reviewable markdown
summary of every role, every privilege, and key/disabled status across both accounts,
written 0600 into `output/` exactly like every other integration's report.

**Sanity check** — `SHOW GRANTS TO USER`, `SHOW GRANTS TO ROLE`, and `SHOW GRANTS OF
ROLE` and their respective column sets (including that `OF ROLE` returns the
role-hierarchy view needed for the recursive walk, while `TO USER`/`TO ROLE` return the
privilege view) were confirmed via docs.snowflake.com/en/sql-reference/sql/show-grants.
Genuine open question: this task is the clearest example in the document of "staging
and prod are separate accounts" being a hard architectural fact rather than a toggle —
producing one unified audit report across both accounts requires two live connections
with two separate credential sets held simultaneously in one run (unlike tasks 1-9,
where only one account is ever touched per invocation), which is a slightly different
shape from every other task here and may be worth its own small design note in
`src/providers/snowflake` (e.g. a `dualAccountConnect` helper) rather than ad hoc
duplication inside this one integration.
