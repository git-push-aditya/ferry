import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  ENVIRONMENT_NAME: nonEmpty,
  SECRET_NAME: nonEmpty,
  // Never logged, never written to resource()/ctx.outputs beyond this run's
  // own process memory.
  SECRET_VALUE: nonEmpty,
  FORCE_ROTATE: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
