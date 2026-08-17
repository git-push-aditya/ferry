import type { StepContext } from "../../../src/core/define";
import { branchProtectionMatches, getBranchProtection, githubClients } from "../../../src/providers/github";
import { desiredBranchProtection, type Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, BRANCH } = ctx.params;

  const live = await getBranchProtection(rest, OWNER, REPO, BRANCH);
  if (!live) throw new Error(`Branch protection on ${OWNER}/${REPO}@${BRANCH} is not configured after apply`);

  const desired = desiredBranchProtection(ctx.params);
  if (!branchProtectionMatches(live, desired)) {
    throw new Error(`Branch protection on ${OWNER}/${REPO}@${BRANCH} does not match the desired document`);
  }

  ctx.log.success(`Confirmed branch protection on ${OWNER}/${REPO}@${BRANCH} matches the desired document`);
}
