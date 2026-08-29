import { z } from "zod";
import { boolFlag, jsonArrayParam } from "../../../src/core/env";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * Replaces grant-role-to-user, revoke-role-from-user and update-user-role.
 * Those three were the same lifecycle question asked three ways -- "which
 * roles should this user hold, and which is their default?" -- expressed as
 * imperative verbs. Stated as a desired set instead, onboarding, offboarding
 * and a mid-tenure role change are all one call with different params, and
 * the step becomes genuinely idempotent rather than idempotent-per-verb.
 */
export const paramsSchema = z
  .object({
    USER_NAME: snowflakeIdentifier,

    // The roles the user should hold when this run finishes.
    ROLES: jsonArrayParam("ROLES", snowflakeIdentifier),

    // When true, roles the user holds that are NOT in ROLES are revoked --
    // this is what makes offboarding `ROLES=[] PRUNE_UNMANAGED_ROLES=true`.
    // Default false so the common case (granting) is purely additive and
    // cannot surprise anyone by removing access.
    PRUNE_UNMANAGED_ROLES: boolFlag("false"),

    // Optional. Must be one of ROLES -- setting a default role the user does
    // not hold leaves a session that cannot assume it.
    DEFAULT_ROLE: snowflakeIdentifier.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.DEFAULT_ROLE) {
      const held = p.ROLES.some((r) => r.toUpperCase() === p.DEFAULT_ROLE!.toUpperCase());
      if (!held) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["DEFAULT_ROLE"],
          message: `DEFAULT_ROLE "${p.DEFAULT_ROLE}" must also appear in ROLES`,
        });
      }
    }
  });

export type Params = z.infer<typeof paramsSchema>;
