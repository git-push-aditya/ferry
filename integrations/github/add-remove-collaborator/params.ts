import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { githubOwner, githubRepoName } from "../../../src/providers/github/params";

export const paramsSchema = z
  .object({
    OWNER: githubOwner,
    REPO: githubRepoName,
    USERNAME: nonEmpty,
    ACTION: z.enum(["add", "remove"]),
    PERMISSION: z.enum(["pull", "triage", "push", "maintain", "admin"]).optional(),
  })
  .refine((p) => p.ACTION !== "add" || Boolean(p.PERMISSION), {
    message: "PERMISSION is required when ACTION=add",
    path: ["PERMISSION"],
  });

export type Params = z.infer<typeof paramsSchema>;
