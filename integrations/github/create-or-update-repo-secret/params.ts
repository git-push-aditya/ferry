import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  SECRET_NAME: nonEmpty,
  // Never logged, never written to resource()/ctx.outputs beyond this run's
  // own process memory — same hygiene as AWS access keys and Snowflake
  // key-pairs elsewhere in this project.
  SECRET_VALUE: nonEmpty,
  // Escape hatch for callers who want to guarantee a fresh value regardless
  // of the presence check — see README for why the default is false.
  FORCE_ROTATE: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
