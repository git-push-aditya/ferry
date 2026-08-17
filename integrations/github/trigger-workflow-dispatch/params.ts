import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName } from "../../../src/providers/github/params";

const jsonObject = z
  .string()
  .optional()
  .default("{}")
  .transform((v, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INPUTS_JSON must be valid JSON" });
      return z.NEVER;
    }
    const isFlatStringMap =
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((val) => typeof val === "string");
    if (!isFlatStringMap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'INPUTS_JSON must be a flat object of string keys to string values, e.g. {"env":"prod"}',
      });
      return z.NEVER;
    }
    return parsed as Record<string, string>;
  });

export const paramsSchema = z.object({
  OWNER: githubOwner,
  REPO: githubRepoName,
  // Numeric workflow id, or the workflow file's basename (e.g. "ci.yml").
  WORKFLOW_ID: nonEmpty,
  REF: nonEmpty,
  // Must match the workflow file's declared workflow_dispatch.inputs schema
  // — this task does not validate that schema itself (would require
  // fetching and parsing the workflow YAML); a mismatch surfaces as
  // whatever 4xx GitHub itself returns.
  INPUTS_JSON: jsonObject,
  WAIT_FOR_COMPLETION: boolFlag("false"),
  POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  EXPECTED_CONCLUSION: z.string().default("success"),
});

export type Params = z.infer<typeof paramsSchema>;
