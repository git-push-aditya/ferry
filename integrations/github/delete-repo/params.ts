import { z } from "zod";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  // Hard human-confirmation gate: commit history, issues, PRs, and settings
  // are gone for good once deleted — GitHub's own support-ticket restore
  // window is a human path, not an API call this integration can invoke.
  ALLOW_DESTRUCTIVE_TEARDOWN: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
