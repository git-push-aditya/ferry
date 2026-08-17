import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  // Numeric workflow id, or the workflow file's basename (e.g. "ci.yml") —
  // GitHub's own workflows endpoints accept either interchangeably.
  WORKFLOW_ID: nonEmpty,
  ACTION: z.enum(["enable", "disable"]),
});

export type Params = z.infer<typeof paramsSchema>;
