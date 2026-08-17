import { z } from "zod";

const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  // Any specific numeric staleness threshold is a policy choice for the
  // caller, not an AWS-recommended default this plan invents on their
  // behalf — 90 is a common baseline, nothing more.
  STALE_THRESHOLD_DAYS: z.coerce.number().int().positive().default(90),

  // AWS-managed / service-linked roles (Path starting /aws-service-role/ or
  // /service-role/) are excluded by default — they are typically not safe or
  // meaningful to flag for cleanup via this generic audit.
  INCLUDE_SERVICE_LINKED_ROLES: boolFlag("false"),

  // The deep pass costs one async Access Advisor job per candidate role, so
  // it defaults off; RoleLastUsed alone is the fast, free default signal.
  RUN_DEEP_ACCESS_ADVISOR_PASS: boolFlag("false"),

  PATH_PREFIX_FILTER: z.string().optional(),
});

export type Params = z.infer<typeof paramsSchema>;
