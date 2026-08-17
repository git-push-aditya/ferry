import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

const paramsInputSchema = z
  .object({
    INSTANCE_ID: nonEmpty,
    // Identity tag used for the idempotent check() lookup — not the AMI
    // Name field (Name can collide or be reused; the tag is what makes a
    // re-run recognize "this run already baked this AMI").
    LOGICAL_NAME: nonEmpty,
    AMI_NAME: nonEmpty,
    DESCRIPTION: z.string().optional(),

    // Configurable, not hardcoded — matches CreateImage's own API default
    // (false). true skips the reboot (crash-consistent snapshots); false
    // reboots the instance first (full consistency). See README for the
    // documented tradeoff, quoted from AWS's own wording.
    NO_REBOOT: boolFlag("false"),

    TAGS_JSON: z.string().default(""),
  })
  .superRefine((p, ctx) => {
    if (!p.TAGS_JSON) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.TAGS_JSON);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TAGS_JSON"],
        message: "must be valid JSON (a flat string-to-string object) or left empty",
      });
      return;
    }
    const isFlatStringMap =
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((v) => typeof v === "string");
    if (!isFlatStringMap) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TAGS_JSON"],
        message: 'must be a flat object of string keys to string values, e.g. {"env":"prod"}',
      });
    }
  });

export const paramsSchema = paramsInputSchema;

export type Params = z.infer<typeof paramsSchema>;

export function parsedTags(params: Params): Record<string, string> {
  return params.TAGS_JSON ? (JSON.parse(params.TAGS_JSON) as Record<string, string>) : {};
}
