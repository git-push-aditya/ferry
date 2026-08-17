# `aws/iam/user/offboard-user`

The HR/access-lifecycle-driven entry point for removing a departed person's
IAM identity: tears down every attached artifact — access keys, login
profile, MFA devices, group memberships, attached + inline policies, signing
certificates, SSH public keys, and service-specific (git) credentials — then
calls `DeleteUser`.

```bash
bun run bin/ferry.ts aws/iam/user/offboard-user --dry-run
bun run bin/ferry.ts aws/iam/user/offboard-user
```

## Same mechanics as `delete-user`, different trigger

This integration's AWS API sequence is **identical** to
`../delete-user` — both call the shared `iamUserTeardownStep` factory from
`src/providers/aws/iam.ts`. There is deliberately no second, independently
maintained copy of a nine-API-call destructive sequence. The two integration
folders exist separately because they are invoked by different teams at
different trigger points: `delete-user` is the generic IAM primitive
(infra-cleanup-driven), while `offboard-user` is the access-lifecycle event
triggered by a person leaving (HR-driven), and carries its own audit-trail
framing (`OFFBOARD_REASON`).

## This is irreversible

**Read this before running it.** Every access key's secret and every login
profile's password is gone the moment it is deleted — AWS never returns
either again after creation, by design. Rollback of this run (if it is
triggered by a later failure) only recreates a **bare** user shell with the
same name; it cannot restore keys, the password, MFA devices, group
memberships, or policy attachments. Reprovisioning after that is a manual
job.

Because of this, `ALLOW_DESTRUCTIVE_TEARDOWN=true` is a **required, explicit
human confirmation**, not a convenience `--force` flag. Leaving it unset (or
`false`) aborts the run in the plan phase, before any AWS API call is made.

## `OFFBOARD_REASON`

Optional, free-text audit-trail metadata (e.g. "resigned 2026-08-10",
"terminated — security incident"). It is **never** passed to any AWS API
call — it exists purely so the generated report records why the offboarding
happened alongside what was torn down.

## What it does

`check()` on the confirmation guard folds a missing/false
`ALLOW_DESTRUCTIVE_TEARDOWN` to `"conflict"`. The teardown step itself is
`iamUserTeardownStep`'s inverted create-or-skip: the user already being gone
is the achieved state (`"exists"` — a re-run after a successful offboarding
is a clean no-op); a present user is `"missing"`, meaning teardown still
needs to run.

## Gotchas

**Rollback recreates a bare shell only.** It is not a real restore — see
the irreversibility section above.
