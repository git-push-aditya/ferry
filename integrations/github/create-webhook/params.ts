import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName, jsonArrayParam } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  URL: nonEmpty,
  CONTENT_TYPE: z.enum(["json", "form"]).default("json"),
  // A shared HMAC secret for signature verification on the receiving end —
  // never logged, write-blind on GitHub's side (same as Actions secrets).
  SECRET: z.string().optional(),
  EVENTS: jsonArrayParam("EVENTS", z.string(), '["push"]'),
  ACTIVE: boolFlag("true"),
});

export type Params = z.infer<typeof paramsSchema>;
