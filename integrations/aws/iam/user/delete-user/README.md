# `aws/iam/user/delete-user`

Deletes an IAM user, tearing down every attached artifact first — access
keys, login profile, MFA devices, group memberships, attached + inline
policies, signing certificates, SSH public keys, and service-specific
(git) credentials — then calls `DeleteUser`. This is `DeleteUser`'s own
documented precondition: AWS refuses to cascade the delete for you.

```bash
bun run bin/ferry.ts aws/iam/user/delete-user --dry-run
bun run bin/ferry.ts aws/iam/user/delete-user
```

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
`false`) aborts the run in the plan phase, before any AWS API call is made —
the same "abort cleanly before touching anything" contract
`delete-empty-bucket` uses for a non-empty bucket.

## What it does

`check()` on the confirmation guard folds a missing/false
`ALLOW_DESTRUCTIVE_TEARDOWN` to `"conflict"`, exactly like
`iamRoleExistsGuardStep`/`iamUserExistsGuardStep` fold a missing precondition
to conflict rather than silently skipping.

The teardown itself is the shared `iamUserTeardownStep` factory from
`src/providers/aws/iam.ts` — the identical sequence used by
`aws/iam/user/offboard-user`. `check()` is inverted (the user already being
gone is the achieved state, `"exists"` — a re-run after a successful delete
is a clean no-op); a present user is `"missing"`, meaning teardown still
needs to run.

## Gotchas

**Not the same integration as `offboard-user`.** The AWS API sequence is
identical and deliberately shared via one factory — the two exist as
separate integration folders only because "delete an IAM user" (generic,
infra-cleanup-driven) and "offboard a person" (HR/access-lifecycle-driven,
with an audit trail) are invoked by different teams at different trigger
points. See `../offboard-user/README.md`.

**Rollback recreates a bare shell only.** It is not a real restore — see
the irreversibility section above.
