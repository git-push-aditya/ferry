import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  TITLE: nonEmpty,
  // Public key material only — private key generation, if needed, happens
  // outside this integration's scope, matching how Snowflake's
  // rotate-user-key-pair only ever handles the public half server-side.
  PUBLIC_KEY: nonEmpty,
  // Defaults true: false grants write access, a meaningfully higher-
  // privilege setting surfaced explicitly rather than defaulted silently,
  // same instinct as EC2's NoReboot param.
  READ_ONLY: boolFlag("true"),
});

export type Params = z.infer<typeof paramsSchema>;
