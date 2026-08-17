import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

/** A JSON object of extra tags, applied alongside the ferry identity tag pair. */
const tagsJson = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return {} as Record<string, string>;
    try {
      const parsed = JSON.parse(v);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      return parsed as Record<string, string>;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object of string tags" });
      return z.NEVER;
    }
  });

export const paramsSchema = z.object({
  // Used as the `ferry:logical-name` identity tag — this is what check()
  // matches on to find "this run's" Elastic IP, the same shape
  // launch-instance uses for the instance it launches.
  LOGICAL_NAME: nonEmpty,

  INSTANCE_ID: nonEmpty,

  TAGS: tagsJson,
});

export type Params = z.infer<typeof paramsSchema>;
