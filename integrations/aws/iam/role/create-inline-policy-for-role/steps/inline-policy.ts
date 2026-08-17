import {
  DeleteRolePolicyCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { awsClients, isNoSuchEntity } from "../../../../../../src/providers/aws";
import { desiredPolicyDocument, type Params } from "../params";

/** Stable-key JSON compare — same rationale as update-trust-policy's. */
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
 * `PutRolePolicy` is documented as "adds *or updates*" a named inline
 * policy — inherently a create-or-replace call, not a separate create-vs-
 * reconcile pair. Whole-document replace under that policy name
 * specifically; other inline policies on the same role, under other names,
 * are untouched.
 *
 * Always reconciles (no create()): the desired document depends on params,
 * not knowable as a plan-time missing/exists split.
 */
export const inlinePolicyStep: Step<Params> = {
  id: "inline-policy",
  title: "Reconcile inline policy on role",

  async check() {
    return "missing";
  },

  async reconcile(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;
    const policyName = ctx.params.POLICY_NAME;
    const desired = desiredPolicyDocument(ctx.params);

    let hadExisting = false;
    let priorDocument: Record<string, unknown> | undefined;
    try {
      const before = await iam.send(
        new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
      );
      hadExisting = true;
      priorDocument = before.PolicyDocument
        ? JSON.parse(decodeURIComponent(before.PolicyDocument))
        : {};
    } catch (err) {
      if (!isNoSuchEntity(err)) throw err;
    }

    if (hadExisting && stableStringify(priorDocument) === stableStringify(desired)) {
      ctx.log.info(
        `Inline policy "${policyName}" on role "${roleName}" already matches the desired document`,
      );
      return {};
    }

    await iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: policyName,
        PolicyDocument: JSON.stringify(desired),
      }),
    );
    ctx.log.success(`Set inline policy "${policyName}" on role "${roleName}"`);

    return {
      changed: true,
      hadExistingInlinePolicy: hadExisting,
      priorInlinePolicyDocument: hadExisting ? JSON.stringify(priorDocument) : "",
    };
  },

  /**
   * Only registered/applicable when reconcile() actually changed something
   * (the same guard shape as `s3BucketPolicyStep`'s rollback): a no-op
   * reconcile never set `hadExistingInlinePolicy`.
   */
  async rollback(ctx) {
    if (ctx.outputs.hadExistingInlinePolicy === undefined) return;

    const { iam } = awsClients(ctx);
    const roleName = ctx.params.ROLE_NAME;
    const policyName = ctx.params.POLICY_NAME;

    try {
      if (ctx.outputs.hadExistingInlinePolicy === false) {
        // This run created it from nothing, so undo means remove it entirely.
        await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }));
        return;
      }

      await iam.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: policyName,
          PolicyDocument: ctx.outputs.priorInlinePolicyDocument as string,
        }),
      );
    } catch (err) {
      // The role (or the policy under it) may already be gone — deleted by
      // a later step in the same run being unwound. Warn, don't crash.
      if (!isNoSuchEntity(err)) throw err;
      ctx.log.warn(
        `Could not roll back inline policy "${policyName}" on role "${roleName}" — role or policy no longer exists`,
      );
    }
  },

  resource(ctx) {
    const roleName = ctx.params.ROLE_NAME;
    const policyName = ctx.params.POLICY_NAME;
    return {
      type: "aws_iam_role_policy",
      name: `${roleName}:${policyName}`,
      attributes: { role: roleName, policyName },
    };
  },
};
