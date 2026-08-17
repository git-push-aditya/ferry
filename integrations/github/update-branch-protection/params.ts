import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName, jsonArrayParam } from "../../../src/providers/github/params";
import type { DesiredBranchProtection } from "../../../src/providers/github/branch-protection";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  BRANCH: nonEmpty,

  ENABLE_REQUIRED_STATUS_CHECKS: boolFlag("false"),
  REQUIRED_STATUS_CHECKS_STRICT: boolFlag("false"),
  REQUIRED_STATUS_CHECKS_CONTEXTS: jsonArrayParam("REQUIRED_STATUS_CHECKS_CONTEXTS", z.string()),

  ENABLE_REQUIRED_PULL_REQUEST_REVIEWS: boolFlag("false"),
  DISMISS_STALE_REVIEWS: boolFlag("false"),
  REQUIRE_CODE_OWNER_REVIEWS: boolFlag("false"),
  REQUIRED_APPROVING_REVIEW_COUNT: z.coerce.number().int().min(0).max(6).optional(),

  ENFORCE_ADMINS: boolFlag("false"),

  ENABLE_RESTRICTIONS: boolFlag("false"),
  RESTRICTIONS_USERS: jsonArrayParam("RESTRICTIONS_USERS", z.string()),
  RESTRICTIONS_TEAMS: jsonArrayParam("RESTRICTIONS_TEAMS", z.string()),
  RESTRICTIONS_APPS: jsonArrayParam("RESTRICTIONS_APPS", z.string()),
});

export type Params = z.infer<typeof paramsSchema>;

/** Builds the full desired document from params — each sub-requirement explicitly null to disable it. */
export function desiredBranchProtection(p: Params): DesiredBranchProtection {
  return {
    required_status_checks: p.ENABLE_REQUIRED_STATUS_CHECKS
      ? { strict: p.REQUIRED_STATUS_CHECKS_STRICT, contexts: p.REQUIRED_STATUS_CHECKS_CONTEXTS }
      : null,
    required_pull_request_reviews: p.ENABLE_REQUIRED_PULL_REQUEST_REVIEWS
      ? {
          dismiss_stale_reviews: p.DISMISS_STALE_REVIEWS,
          require_code_owner_reviews: p.REQUIRE_CODE_OWNER_REVIEWS,
          required_approving_review_count: p.REQUIRED_APPROVING_REVIEW_COUNT ?? 1,
        }
      : null,
    enforce_admins: p.ENFORCE_ADMINS,
    restrictions: p.ENABLE_RESTRICTIONS
      ? { users: p.RESTRICTIONS_USERS, teams: p.RESTRICTIONS_TEAMS, apps: p.RESTRICTIONS_APPS }
      : null,
  };
}
