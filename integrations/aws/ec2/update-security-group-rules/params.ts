import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";
import type { DesiredRule } from "./steps/rules";

/**
 * A JSON array of desired rules, each `{ protocol, fromPort?, toPort?, cidr?,
 * sourceGroupId? }` with exactly one of `cidr`/`sourceGroupId` — the same
 * verified AWS constraint the diff logic in `steps/rules.ts` relies on.
 */
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
  GROUP_ID: nonEmpty,

  // Desired ongoing rule set — the FULL set, not a delta. reconcile() diffs
  // this against the live rule set every run and applies only what's missing
  // or extra.
  DESIRED_INGRESS_RULES: rulesJson("DESIRED_INGRESS_RULES"),
  DESIRED_EGRESS_RULES: rulesJson("DESIRED_EGRESS_RULES"),
});

export type Params = z.infer<typeof paramsSchema>;
