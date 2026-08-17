import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

/**
 * TAGS is required here (unlike tag-bucket's optional TAGS_JSON) — this
 * integration always reconciles against the desired set on every run, and an
 * "untouched" mode wouldn't do anything.
 */
const tagsJson = z.string().transform((v, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
    return z.NEVER;
  }
  const isFlatStringMap =
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((v2) => typeof v2 === "string");
  if (!isFlatStringMap) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a flat object of string keys to string values, e.g. {\"env\":\"prod\"}",
    });
    return z.NEVER;
  }
  return parsed as Record<string, string>;
});

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  INSTANCE_ID: nonEmpty,
  TAGS: tagsJson,

  // Default false — this step only ever adds/updates tags it's told about and
  // never removes a tag some other process or person set, mirroring the
  // general "don't silently undo things this run didn't do" instinct.
  PRUNE_UNMANAGED_TAGS: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
