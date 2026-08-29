import { z } from "zod";
import { jsonArrayParam, nonEmpty } from "../../../src/core/env";
import { githubOwner, githubRepoName } from "../../../src/providers/github/params";

/**
 * SECURITY_GROUP_IDS arrives as a comma-separated string (folder .env values
 * are always strings) and becomes the string[] RunInstances wants.
 */
const securityGroupIds = nonEmpty.transform((v) =>
  v
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);

export const paramsSchema = z
  .object({
    // --- where the runner registers ---------------------------------------
    // "repo" registers against one repository; "org" against the whole org.
    SCOPE: z.enum(["repo", "org"]).default("repo"),
    OWNER: githubOwner.optional(),
    REPO: githubRepoName.optional(),
    ORG: nonEmpty.optional(),

    /**
     * Identity for this runner, and what `check()` matches on. GitHub does
     * NOT enforce uniqueness of runner names, so this is a convention this
     * integration relies on rather than a guarantee it can lean on.
     */
    RUNNER_NAME: nonEmpty,
    RUNNER_LABELS: jsonArrayParam("RUNNER_LABELS", nonEmpty, '["self-hosted"]'),
    // 1 is "Default" on every account.
    RUNNER_GROUP_ID: z.coerce.number().int().positive().default(1),

    // --- the instance it runs on ------------------------------------------
    /**
     * Strongly recommended: an AMI with the runner binary already installed
     * at RUNNER_DIR. A JIT config expires faster than an install-on-boot
     * script usually completes -- see the README.
     */
    AMI_ID: nonEmpty,
    INSTANCE_TYPE: nonEmpty,
    SUBNET_ID: nonEmpty,
    SECURITY_GROUP_IDS: securityGroupIds,
    KEY_PAIR_NAME: z.string().optional(),

    /** Where the runner binary lives on the AMI. */
    RUNNER_DIR: nonEmpty.optional().default("/opt/actions-runner"),
    /** Unix user that owns RUNNER_DIR and runs the agent. */
    RUNNER_USER: nonEmpty.optional().default("ec2-user"),

    // --- the IAM identity the instance assumes ----------------------------
    IAM_ROLE_NAME: nonEmpty,
    IAM_INSTANCE_PROFILE_NAME: nonEmpty,
  })
  .superRefine((p, ctx) => {
    const require = (key: "OWNER" | "REPO" | "ORG") => {
      if (!p[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when SCOPE=${p.SCOPE}`,
        });
      }
    };
    if (p.SCOPE === "repo") {
      require("OWNER");
      require("REPO");
    } else {
      require("ORG");
    }
  });

export type Params = z.infer<typeof paramsSchema>;

/** Narrow the optional params down to the RunnerScope this run addresses. */
export function runnerScope(p: Params) {
  return p.SCOPE === "repo"
    ? { kind: "repo" as const, owner: p.OWNER!, repo: p.REPO! }
    : { kind: "org" as const, org: p.ORG! };
}
