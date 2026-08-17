import { GetRoleCommand } from "@aws-sdk/client-iam";
import type { StepContext } from "../../../../../src/core/define";
import { awsClients } from "../../../../../src/providers/aws";
import { desiredTrustPolicy, type Params } from "./params";

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
  const desired = desiredTrustPolicy(ctx.params);

  const got = await iam.send(new GetRoleCommand({ RoleName: roleName }));
  const rawCurrent = got.Role?.AssumeRolePolicyDocument;
  const current = rawCurrent ? JSON.parse(decodeURIComponent(rawCurrent)) : {};

  if (stableStringify(current) !== stableStringify(desired)) {
    throw new Error(`Trust policy on role "${roleName}" does not match the desired document`);
  }
  ctx.log.success(`Confirmed trust policy on role "${roleName}" matches the desired document`);
}
