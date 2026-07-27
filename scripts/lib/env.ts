import { z } from "zod";

function fail(errors: z.ZodError): never {
  const keys = [...new Set(errors.issues.map((i) => i.path.join(".")))];
  console.error("Missing or invalid environment variables:");
  for (const k of keys) console.error(`  - ${k}`);
  process.exit(1);
}

const nonEmpty = z.string().min(1, "must not be empty");

const awsBootstrapSchema = {
  AWS_ACCESS_KEY_ID: nonEmpty,
  AWS_SECRET_ACCESS_KEY: nonEmpty,
  AWS_SESSION_TOKEN: z.string().optional(),
  AWS_REGION: nonEmpty,
};

const s3TargetSchema = {
  EXPORT_S3_BUCKET: nonEmpty.refine(
    (v) => !v.startsWith("s3://") && !v.endsWith("/"),
    "must be a bare bucket name — no s3:// prefix, no trailing slash",
  ),
  EXPORT_S3_PREFIX: nonEmpty.refine((v) => v.endsWith("/"), "must end with '/'"),
};

const integrationEnvSchema = z
  .object({
    ...awsBootstrapSchema,
    ...s3TargetSchema,
    SNOWFLAKE_ACCOUNT: nonEmpty,
    SNOWFLAKE_USERNAME: nonEmpty,
    SNOWFLAKE_PASSWORD: z.string().optional(),
    SNOWFLAKE_PRIVATE_KEY: z.string().optional(),
    SNOWFLAKE_ROLE: nonEmpty,
    SNOWFLAKE_WAREHOUSE: nonEmpty,
    SNOWFLAKE_DATABASE: nonEmpty,
    SNOWFLAKE_SCHEMA: nonEmpty,
    SF_STORAGE_INTEGRATION_NAME: nonEmpty,
    SF_STAGE_NAME: nonEmpty,
    AWS_STORAGE_ROLE_NAME: nonEmpty,
    AWS_STORAGE_POLICY_NAME: nonEmpty,
  })
  .superRefine((val, ctx) => {
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

const backendEnvSchema = z.object({
  ...awsBootstrapSchema,
  ...s3TargetSchema,
  BACKEND_IAM_USER_NAME: nonEmpty,
  BACKEND_IAM_POLICY_NAME: nonEmpty,
});

export type IntegrationEnv = z.infer<typeof integrationEnvSchema>;
export type BackendEnv = z.infer<typeof backendEnvSchema>;

export function loadIntegrationEnv(): IntegrationEnv {
  const result = integrationEnvSchema.safeParse(process.env);
  if (!result.success) fail(result.error);
  return result.data;
}

export function loadBackendEnv(): BackendEnv {
  const result = backendEnvSchema.safeParse(process.env);
  if (!result.success) fail(result.error);
  return result.data;
}
