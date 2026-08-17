import { GetRolePolicyCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import { desiredPolicyDocument, type Params } from "./params";

/** Stable-key JSON compare, same rationale as the reconcile step's. */
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

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const roleName = ctx.params.ROLE_NAME;
  const policyName = ctx.params.POLICY_NAME;
  const desired = desiredPolicyDocument(ctx.params);

  const got = await iam.send(
    new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName }),
  );
  const current = got.PolicyDocument ? JSON.parse(decodeURIComponent(got.PolicyDocument)) : {};

  if (stableStringify(current) !== stableStringify(desired)) {
    throw new Error(
      `Inline policy "${policyName}" on role "${roleName}" does not match the desired document`,
    );
  }
  ctx.log.success(
    `Confirmed inline policy "${policyName}" on role "${roleName}" matches the desired document`,
  );
}
