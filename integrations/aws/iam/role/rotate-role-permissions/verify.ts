import type { StepContext } from "../../../../../src/core/define";
import { pollUntil } from "../../../../../src/core/wait";
import { awsClients, listAttachedRolePolicyArns } from "../../../../../src/providers/aws";
import type { Params } from "./params";

/**
 * Confirms the final attached-ARN set exactly equals DESIRED_POLICY_ARNS, as
 * a set (order doesn't matter), riding out IAM's attachment-visibility
 * eventual consistency with pollUntil.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { iam } = awsClients(ctx);
  const roleName = ctx.params.ROLE_NAME;
  const desired = new Set(ctx.params.DESIRED_POLICY_ARNS);

  let finalArns: string[] = [];
  const confirmed = await pollUntil(
    async () => {
      finalArns = await listAttachedRolePolicyArns(iam, roleName);
      const current = new Set(finalArns);
      return current.size === desired.size && [...desired].every((a) => current.has(a));
    },
    { intervalMs: 2_000, timeoutMs: 15_000, label: `${roleName} attached-policy set` },
  );

  if (!confirmed) {
    const current = new Set(finalArns);
    const missing = [...desired].filter((a) => !current.has(a));
    const extra = finalArns.filter((a) => !desired.has(a));
    throw new Error(
      `${roleName}'s attached policies do not match the desired set. Missing: [${missing.join(", ")}]. Extra: [${extra.join(", ")}].`,
    );
  }

  ctx.log.success(`Confirmed ${roleName} has exactly the desired ${desired.size} policy attachment(s)`);
}
