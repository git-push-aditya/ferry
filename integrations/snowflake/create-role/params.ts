import { z } from "zod";
import { snowflakeIdentifier } from "../../../src/providers/snowflake";

/**
 * A single initial grant issued at role-creation time, e.g.
 * `{ "privilege": "USAGE", "onType": "WAREHOUSE", "onName": "COMPUTE_WH" }`.
 */
const initialGrantSchema = z.object({
  privilege: z.string().min(1),
  onType: z.string().min(1),
  onName: z.string().min(1),
});

export type InitialGrant = z.infer<typeof initialGrantSchema>;

/**
 * `INITIAL_GRANTS` arrives as a JSON string (folder .env values are always
 * strings) and is parsed/validated here rather than left as a raw string for
 * every consumer to re-parse. Absent entirely, the role is created with no
 * starting privileges — a legitimate case (e.g. a role meant to be composed
 * later purely via `GRANT ROLE ... TO ROLE`).
 */
export const paramsSchema = z
  .object({
    ROLE_NAME: snowflakeIdentifier,
    INITIAL_GRANTS: z
      .string()
      .optional()
      .transform((raw, ctx) => {
        if (!raw || !raw.trim()) return [] as InitialGrant[];
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "INITIAL_GRANTS must be valid JSON" });
          return z.NEVER;
        }
        const result = z.array(initialGrantSchema).safeParse(parsed);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `INITIAL_GRANTS must be an array of {privilege, onType, onName}: ${result.error.message}`,
          });
          return z.NEVER;
        }
        return result.data;
      }),
  });

export type Params = z.infer<typeof paramsSchema>;
