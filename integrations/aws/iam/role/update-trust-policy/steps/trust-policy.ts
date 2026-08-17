import { GetRoleCommand, UpdateAssumeRolePolicyCommand } from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients } from "../../../../../../src/providers/aws";
import { desiredTrustPolicy, type Params } from "../params";

/**
 * Stable-key JSON serialization so two structurally-identical documents
 * compare equal regardless of key order or incidental whitespace — IAM may
 * reformat either on read-back, so a naive string compare would false-diff
 * an already-converged policy.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whole-document replace, same shape as `s3BucketPolicyStep`: there is no
 * "add one trust statement" API, so the full document is always supplied.
 * Unlike a bucket policy, a role's trust policy is required at creation —
 * `GetRole` always returns a real `AssumeRolePolicyDocument` — so there is no
 * "no prior config" branch to special-case here.
 *
 * Always reconciles (no create()): the desired document depends on params,
 * not knowable as a plan-time missing/exists split.
 */
export const trustPolicyStep: Step<Params> = {
  id: "trust-policy",
  title: "Reconcile role trust policy",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;
    const desired = desiredTrustPolicy(ctx.params);

    const before = await iam.send(new GetRoleCommand({ RoleName: roleName }));
    const rawCurrent = before.Role?.AssumeRolePolicyDocument;
    const current = rawCurrent ? JSON.parse(decodeURIComponent(rawCurrent)) : {};

    if (stableStringify(current) === stableStringify(desired)) {
      ctx.log.info(`Trust policy on role "${roleName}" already matches the desired document`);
      return {};
    }

    await iam.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: roleName,
        PolicyDocument: JSON.stringify(desired),
      }),
    );
    ctx.log.success(`Updated trust policy on role "${roleName}"`);

    return {
      changed: true,
      priorTrustPolicy: JSON.stringify(current),
    };
  },

  /**
   * Only registered/applicable when reconcile() actually changed the
   * document (the same guard shape as `s3BucketPolicyStep`'s rollback):
   * a no-op reconcile never set `priorTrustPolicy`, so there is nothing to
   * restore.
   */
  async rollback(ctx) {
    const prior = ctx.outputs.priorTrustPolicy as string | undefined;
    if (prior === undefined) return;

    await awsClients(ctx).iam.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: ctx.params.ROLE_NAME,
        PolicyDocument: prior,
      }),
    );
  },

  resource(ctx) {
    return {
      type: "aws_iam_role_trust_policy",
      name: ctx.params.ROLE_NAME,
      attributes: {
        role: ctx.params.ROLE_NAME,
        changed: String(ctx.outputs.changed === true),
      },
    };
  },
};
