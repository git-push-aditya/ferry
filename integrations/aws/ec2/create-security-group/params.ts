import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";
import type { DesiredRule } from "../update-security-group-rules/steps/rules";

/** Same JSON-array-of-rules shape as update-security-group-rules' params. */
function rulesJson(label: string) {
  return z
    .string()
    .optional()
    .default("[]")
    .transform((v, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be valid JSON` });
        return z.NEVER;
      }
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a JSON array` });
        return z.NEVER;
      }
      const rules: DesiredRule[] = [];
      parsed.forEach((entry, index) => {
        const result = desiredRuleSchema.safeParse(entry);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label}[${index}] is invalid: ${result.error.issues.map((i) => i.message).join(", ")}`,
          });
          return;
        }
        rules.push(result.data);
      });
      return rules;
    });
}

const desiredRuleSchema = z
  .object({
    protocol: nonEmpty,
    fromPort: z.number().int().optional(),
    toPort: z.number().int().optional(),
    cidr: z.string().optional(),
    sourceGroupId: z.string().optional(),
  })
  .refine((r) => Boolean(r.cidr) !== Boolean(r.sourceGroupId), {
    message: "exactly one of cidr or sourceGroupId is required",
  });

export const paramsSchema = z.object({
  GROUP_NAME: nonEmpty,
  GROUP_DESCRIPTION: nonEmpty,
  VPC_ID: nonEmpty,

  // Starting rule lists, applied once at creation (or caught up by
  // reconcile() if a prior partial run left the group under-ruled).
  INGRESS_RULES: rulesJson("INGRESS_RULES"),
  EGRESS_RULES: rulesJson("EGRESS_RULES"),
});

export type Params = z.infer<typeof paramsSchema>;
