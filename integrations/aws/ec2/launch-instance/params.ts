import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

/**
 * SECURITY_GROUP_IDS arrives as a comma-separated string in the .env (folder
 * .env values are always strings) and is transformed into the string[]
 * RunInstances actually wants.
 */
const securityGroupIds = nonEmpty.transform((v) =>
  v
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);

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
  // matches on, not the instance id (which doesn't exist until create()).
  LOGICAL_NAME: nonEmpty,

  AMI_ID: nonEmpty,
  INSTANCE_TYPE: nonEmpty,
  SUBNET_ID: nonEmpty,
  SECURITY_GROUP_IDS: securityGroupIds,

  KEY_PAIR_NAME: z.string().optional(),

  // Accepted as an override so a re-run after a partial failure (RunInstances
  // succeeded, poll didn't) can be forced to reuse the same token rather than
  // generating a fresh one that would launch a second instance.
  CLIENT_TOKEN_OVERRIDE: z.string().optional(),

  TAGS: tagsJson,
});

export type Params = z.infer<typeof paramsSchema>;
