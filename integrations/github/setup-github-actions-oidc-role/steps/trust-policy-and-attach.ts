import { GetRoleCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../src/core/define";
import {
  attachRolePolicy,
  awsClients,
  detachRolePolicy,
  listAttachedRolePolicyArns,
} from "../../../../src/providers/aws";
import { githubOidcTrustPolicy, type Params } from "../params";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Always-reconcile for the trust-policy content, plus ensure-attached for
 * the permission policies — same whole-document-replace shape as
 * aws/iam/role/update-trust-policy's own step (reimplemented locally here
 * rather than imported, since that integration's step is typed to its own
 * Params shape, not exported as a shared factory the way iamRoleStep is).
 *
 * check() always defers to reconcile(): the role this step patches is
 * guaranteed to exist by the time apply reaches this step (oidc-provider-
 * and-role runs first in the array and creates it if missing), but at
 * PLAN time that ordering hasn't executed yet, so check() cannot safely
 * probe the role — same "defer to apply" convention update-trust-policy's
 * own check() uses.
 */
export const trustPolicyAndAttachStep: Step<Params> = {
  id: "trust-policy-and-attach",
  title: "Reconcile the role's trust policy and attach permission policies",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.AWS_ROLE_NAME;
    const desiredTrustPolicy = githubOidcTrustPolicy(ctx.accountId, ctx.params);

    const before = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    const rawCurrent = before.Role?.AssumeRolePolicyDocument;
    const currentTrustPolicy = rawCurrent ? JSON.parse(decodeURIComponent(rawCurrent)) : {};

    let trustPolicyChanged = false;
    let priorTrustPolicy: string | undefined;
    if (stableStringify(currentTrustPolicy) !== stableStringify(desiredTrustPolicy)) {
      priorTrustPolicy = JSON.stringify(currentTrustPolicy);
      await iam.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: roleName,
          PolicyDocument: JSON.stringify(desiredTrustPolicy),
        }),
      );
      trustPolicyChanged = true;
      ctx.log.success(`Updated trust policy on role "${roleName}"`);
    } else {
      ctx.log.info(`Trust policy on role "${roleName}" already matches — no-op`);
    }

    const currentlyAttached = new Set(await listAttachedRolePolicyArns(iam, roleName));
    const attachedThisRun: string[] = [];
    for (const policyArn of ctx.params.PERMISSION_POLICY_ARNS) {
      if (currentlyAttached.has(policyArn)) continue;
      await attachRolePolicy(iam, roleName, policyArn);
      attachedThisRun.push(policyArn);
    }
    if (attachedThisRun.length) {
      ctx.log.success(`Attached ${attachedThisRun.length} permission polic(y/ies) to "${roleName}"`);
    }

    return {
      trustPolicyChanged,
      priorTrustPolicy: priorTrustPolicy ?? "",
      attachedPolicyArnsThisRun: JSON.stringify(attachedThisRun),
    };
  },

  /**
   * Detaches any policies this run attached, then restores the role's prior
   * trust policy if this reconcile changed it. If the role itself was
   * created this run, its own step's rollback (which runs after this one,
   * LIFO) deletes the whole role anyway, so a restore here is not fatal
   * even though it's momentarily redundant.
   */
  async rollback(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.AWS_ROLE_NAME;

    const attachedThisRun = JSON.parse(String(ctx.outputs.attachedPolicyArnsThisRun ?? "[]")) as string[];
    for (const policyArn of attachedThisRun) {
      await detachRolePolicy(iam, roleName, policyArn);
    }

    if (ctx.outputs.trustPolicyChanged === true) {
      const prior = String(ctx.outputs.priorTrustPolicy ?? "");
      if (prior) {
        await iam.send(new UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: prior }));
      }
    }
  },

  resource(ctx) {
    return {
      type: "aws_iam_role_trust_policy",
      name: ctx.params.AWS_ROLE_NAME,
      attributes: {
        role: ctx.params.AWS_ROLE_NAME,
        githubRepo: `${ctx.params.GITHUB_OWNER}/${ctx.params.GITHUB_REPO}`,
        scopeType: ctx.params.SCOPE_TYPE,
        allowAnyRefOrEnvironment: String(ctx.params.ALLOW_ANY_REF_OR_ENVIRONMENT),
      },
    };
  },
};
