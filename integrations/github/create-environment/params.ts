import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName, jsonArrayParam } from "../../../src/providers/github/params";

const reviewerSchema = z.object({
  type: z.enum(["User", "Team"]),
  id: z.coerce.number().int(),
});

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  ENVIRONMENT_NAME: nonEmpty,

  // Minutes to wait before allowing deployments to proceed.
  WAIT_TIMER: z.coerce.number().int().min(0).max(43_200).default(0),
  // JSON array of { "type": "User"|"Team", "id": number }.
  REVIEWERS: jsonArrayParam("REVIEWERS", reviewerSchema),

  ENABLE_DEPLOYMENT_BRANCH_POLICY: boolFlag("false"),
  PROTECTED_BRANCHES: boolFlag("false"),
  CUSTOM_BRANCH_POLICIES: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;

export interface DeploymentBranchPolicy {
  protected_branches: boolean;
  custom_branch_policies: boolean;
}

export function desiredDeploymentBranchPolicy(p: Params): DeploymentBranchPolicy | null {
  return p.ENABLE_DEPLOYMENT_BRANCH_POLICY
    ? { protected_branches: p.PROTECTED_BRANCHES, custom_branch_policies: p.CUSTOM_BRANCH_POLICIES }
    : null;
}
