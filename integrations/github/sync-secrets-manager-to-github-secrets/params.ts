import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z
  .object({
    // Secrets Manager's SecretId accepts either an ARN or a friendly name.
    SOURCE_SECRET_ID: nonEmpty,

    OWNER: githubOwner,
    REPO: githubRepoName,
    TARGET_SCOPE: z.enum(["repo", "environment"]),
    // Required when TARGET_SCOPE=environment.
    ENVIRONMENT_NAME: z.string().optional(),

    // May differ from the Secrets Manager secret's own name.
    TARGET_SECRET_NAME: nonEmpty,
  })
  .refine((p) => p.TARGET_SCOPE !== "environment" || Boolean(p.ENVIRONMENT_NAME?.trim()), {
    message: "ENVIRONMENT_NAME is required when TARGET_SCOPE=environment",
    path: ["ENVIRONMENT_NAME"],
  });

export type Params = z.infer<typeof paramsSchema>;
