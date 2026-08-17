import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z
  .object({
    VOLUME_ID: nonEmpty,
    // Identity tag used at snapshot-creation time so a retried run can find
    // "did I already snapshot this volume for this reason" via
    // DescribeSnapshots, rather than blindly creating a second snapshot —
    // snapshots have no natural pre-existing identity the way a bucket name
    // does.
    LOGICAL_NAME: nonEmpty,
    DESCRIPTION: z.string().default(""),
    // Flat string-to-string JSON object, same shape as tag-bucket's TAGS_JSON.
    TAGS: z.string().default(""),
    // A recommended-not-required convenience specifically for root-volume
    // consistency — EBS itself can snapshot an attached, in-use volume
    // directly.
    STOP_INSTANCE_FIRST: boolFlag("false"),
    INSTANCE_ID: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    if (!p.TAGS) {
      // nothing to validate
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(p.TAGS);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TAGS"],
          message: "must be valid JSON (a flat string-to-string object) or left empty",
        });
        parsed = undefined;
      }
      if (parsed !== undefined) {
        const isFlatStringMap =
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          Object.values(parsed).every((v) => typeof v === "string");
        if (!isFlatStringMap) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["TAGS"],
            message: 'must be a flat object of string keys to string values, e.g. {"env":"prod"}',
          });
        }
      }
    }

    if (p.STOP_INSTANCE_FIRST && !p.INSTANCE_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["INSTANCE_ID"],
        message: "required when STOP_INSTANCE_FIRST=true",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;

export function parsedTags(params: Params): Record<string, string> {
  return params.TAGS ? (JSON.parse(params.TAGS) as Record<string, string>) : {};
}
