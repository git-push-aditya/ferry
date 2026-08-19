# `github/github-oidc-spoke-role`

The cross-account "N environments, one repo" case for GitHub Actions OIDC.

**Structural finding this integration is built around**: an IAM OIDC
provider is account-scoped — confirmed against the
`CreateOpenIDConnectProvider` API reference, which enforces one
registration per provider URL *per account*. A true multi-AWS-account
rollout therefore cannot share the single OIDC provider + role
`github/setup-github-actions-oidc-role` creates in one account. This
integration adopts **hub-and-spoke** instead of minting N independent
OIDC providers: one account (the hub) holds the OIDC provider + a hub role
(via a plain `github/setup-github-actions-oidc-role` run); every other
account gets a spoke role — this integration — that trusts the **hub
role's ARN** via an ordinary `sts:AssumeRole`, not OIDC directly. This
keeps the OIDC trust surface in exactly one place for audit purposes.

```bash
bun run bin/ferry.ts github/github-oidc-spoke-role --dry-run
bun run bin/ferry.ts github/github-oidc-spoke-role
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `iam-role` | the spoke role in this account | create-or-skip |
| `trust-policy` | the spoke role's trust policy | always-reconcile — corrects drift on an already-existing role |
| `converge-policy-attachments` | the spoke role's attached managed policies | always-reconcile to exactly `SPOKE_PERMISSION_POLICY_ARNS` |
| `verify` | re-reads both | — |

## What it needs

**Root `.env`** — `credentials: ["aws"]` only, pointed at **this** target
account (not the hub account).

**This folder's `.env`** — see `.env.example`: `HUB_ROLE_ARN` (from a
`github/setup-github-actions-oidc-role` run against the hub account),
`SPOKE_ROLE_NAME`, `SPOKE_PERMISSION_POLICY_ARNS`, `ROLE_DESCRIPTION`.

## Gotchas

**Run this once per target AWS account.** This integration deliberately
does not hold multiple AWS credential sets in one run — the same "N
secrets = N runs" granularity convention `github/create-or-update-repo-
secret`'s own docs already establish. Point root `.env` at each target
account in turn and re-run.

**A real design tradeoff, not an API constraint**: hub-and-spoke vs. N
independent OIDC providers. Hub-and-spoke avoids re-registering the OIDC
trust surface N times but adds a second `sts:AssumeRole` hop's
latency/failure surface to every workflow run (see the two-hop usage
example in this integration's generated report). An alternative design
could give each account its own independent
`github/setup-github-actions-oidc-role` run instead — no second hop, at
the cost of N separate OIDC trust surfaces to audit. Confirm which
tradeoff fits before standardizing on this integration across many
accounts.

**No Condition block on the spoke role's trust policy**, unlike
`github/setup-github-actions-oidc-role`'s OIDC-token trust — this is
ordinary role-to-role trust (`Principal: { AWS: <hub role arn> }`), which
doesn't carry `aud`/`sub` claims to condition on. The hub role is the only
place OIDC-specific trust conditions live in this chain.
