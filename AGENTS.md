# Ferry agent instructions

Ferry is security-sensitive infrastructure automation. Treat this repository the way you would treat Terraform, CloudFormation, or production IaC.

## Non-negotiable safety rules

- Never access `.env` files.
- Never access secret files, credential stores, keychains, or local cloud credential caches.
- Never print secret values, tokens, access keys, private keys, generated passwords, or raw credential material.
- Never inspect generated credentials unless the user explicitly provides them for the current task.
- Never commit generated credentials, secret outputs, local reports with sensitive data, or other sensitive artifacts.

## Approval required before changing security-sensitive behavior

Get explicit user approval before changing any of the following:

- IAM policy semantics
- trust policies
- allow/deny behavior
- permission boundaries
- least-privilege scope
- credential handling or credential resolution
- secret persistence or output persistence
- execution order where resource or security dependencies may be affected
- rollback or destructive behavior
- cloud-resource lifecycle semantics

Before requesting approval, explain exactly what would change and why.

## Engineering expectations

- Preserve existing behavior unless the user explicitly asks for a change.
- Prefer small, focused edits over broad refactors.
- Do not loosen permissions for convenience.
- Do not silently add persistence of credentials or secrets.
- Keep integration use-cases independent. Do not introduce hidden workflow coupling between sibling integration folders.
- Update comments and docs alongside code when behavior or guarantees are clarified.

## Verification

- Inspect relevant files before editing.
- Run the relevant typechecks and tests after making changes.
- In the final report, list the files changed, the behavior impact, and any security implications.
