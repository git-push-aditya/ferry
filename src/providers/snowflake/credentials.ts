import { z } from "zod";
import { nonEmpty } from "../../core/env";

export const SNOWFLAKE_CREDENTIAL_KEYS = [
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_USERNAME",
  "SNOWFLAKE_PASSWORD",
  "SNOWFLAKE_PRIVATE_KEY",
  "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE",
  "SNOWFLAKE_ROLE",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
] as const;

export const snowflakeCredentialsSchema = z
  .object({
    SNOWFLAKE_ACCOUNT: nonEmpty,
    SNOWFLAKE_USERNAME: nonEmpty,
    SNOWFLAKE_PASSWORD: z.string().optional(),
    SNOWFLAKE_PRIVATE_KEY: z.string().optional(),
    SNOWFLAKE_PRIVATE_KEY_PASSPHRASE: z.string().optional(),
    SNOWFLAKE_ROLE: nonEmpty,
    SNOWFLAKE_WAREHOUSE: nonEmpty,
    SNOWFLAKE_DATABASE: nonEmpty,
    SNOWFLAKE_SCHEMA: nonEmpty,
  })
  .superRefine((val, ctx) => {
    // Either auth method is fine; neither is not. Reported against both keys so
    // the fail-fast listing names every field the user could fill in.
    if (!val.SNOWFLAKE_PASSWORD?.trim() && !val.SNOWFLAKE_PRIVATE_KEY?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "either SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY is required",
        path: ["SNOWFLAKE_PASSWORD"],
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "either SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY is required",
        path: ["SNOWFLAKE_PRIVATE_KEY"],
      });
    }
  });

export type SnowflakeCredentials = z.infer<typeof snowflakeCredentialsSchema>;
