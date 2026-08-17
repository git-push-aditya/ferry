# `aws/iam/user/enforce-mfa`

**Read this before assuming "MFA is enforced" means what you think it means.**

There is **no "require MFA" attribute on an IAM user.** MFA enforcement in
AWS is exclusively a *policy Condition* mechanism: a condition key
(`aws:MultiFactorAuthPresent`, and optionally `aws:MultiFactorAuthAge`)
evaluated against session context that only exists when the caller obtained
temporary credentials via `GetSessionToken` or `AssumeRole` with an MFA code.

**Long-term IAM user access keys never carry MFA session context.** A caller
using a plain `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` pair can never
satisfy an MFA condition — the condition simply denies them, unconditionally,
forever. This integration attaching an MFA condition to a policy does
**not** force any particular caller to route through `GetSessionToken`/
`AssumeRole` first; it only makes the protected actions unreachable without
that context. "Enforcing MFA" in the everyday sense (require MFA at sign-in,
gate specific API calls behind it) genuinely requires the caller's own
workflow to route through STS temporary credentials — this integration alone
does not, and cannot, make that happen.

**Device provisioning alone is not enforcement.** `CreateVirtualMFADevice`
allocates a device and a Base32/QR seed. `EnableMFADevice` — the call that
actually associates the device with the user so it can produce valid session
context — requires **two live, sequential TOTP codes**, which only a human
(via their authenticator app) can produce. Ferry cannot supply these. This
integration's device half can only reach **"awaiting human enablement"**,
never a clean "enabled" state. Until a human completes `EnableMFADevice`,
provisioning a device has changed nothing about what any caller can do.

```bash
bun run bin/ferry.ts aws/iam/user/enforce-mfa --dry-run
bun run bin/ferry.ts aws/iam/user/enforce-mfa
```

## What it does

This is two independent steps, deliberately not conflated into one — they
have entirely different idempotency shapes and completion states.

| Step | Notes |
| --- | --- |
| `iam-user-exists` | aborts in the plan phase if the user doesn't exist |
| `mfa-device-provision` | creates a virtual MFA device if none is registered and `PROVISION_VIRTUAL_DEVICE=true`; can only reach "awaiting human enablement" |
| `mfa-policy-condition` | always reconciles — adds the MFA condition to every statement of `IAM_POLICY_ARN`'s default version |
| `verify` | policy half is a clean pass/fail; device half never fails verify() just because enablement is still pending |

## Completing device enablement (manual, out of Ferry's scope)

1. Ferry prints the device's Base32 seed to stdout once, at provisioning
   time. It is not persisted anywhere.
2. Scan/enter that seed into an authenticator app (Google Authenticator,
   1Password, etc.).
3. Get two sequential codes from the app.
4. Call `EnableMFADevice` (AWS Console, CLI, or your own follow-up tool) with
   the serial number and both codes. Only then is the device actually usable
   for MFA-conditioned sessions.

## Gotchas

**`IAM_POLICY_ARN` must be a customer-managed policy.** AWS-managed policies
(`arn:aws:iam::aws:policy/...`) cannot have new versions created on them —
`CreatePolicyVersion` will fail. This integration does not validate the ARN's
origin up front (that requires a live API call); a bad ARN surfaces as a
clean error at reconcile time.

**The condition is added to every statement, not a dedicated new one.** This
integration's implementation choice: merging the `Condition` block into every
existing statement of the target policy ("every action this policy grants now
requires MFA") rather than carving out a separate statement, which would risk
duplicating `Action`/`Resource` blocks and drifting out of sync with them.

**IAM caps a policy at 5 versions.** If the target policy is already at the
cap, this integration deletes the oldest *non-default* version to make room
before creating a new one — it never touches the current default until the
new version is confirmed created.

**Rollback of the policy half reinstates the prior default version** via
`SetDefaultPolicyVersion` rather than reconstructing the prior JSON as a new
version — cleaner, and avoids any risk of a lossy round-trip through
`JSON.stringify`/`decodeURIComponent`.

**Rollback of the device half never deletes an already-enabled device.** If
a human completed `EnableMFADevice` between this run and a rollback, the
device now shows up in `ListMFADevices` for the user — deleting it would
destroy working MFA, so rollback warns and leaves it alone instead.

**`ListMFADevices` only lists *enabled* devices.** An unenabled virtual
device created via `CreateVirtualMFADevice` does not appear there until
`EnableMFADevice` succeeds. `verify()` relies on this precisely: if the
device isn't listed but this run marked it `mfaAwaitingHumanEnablement`,
that's the expected state, not a failure — `verify()` passes and reports the
truth instead of rolling back a policy change that is correctly in place.
