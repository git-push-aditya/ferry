import { z } from "zod";
import { nonEmpty } from "../../core/env";

/**
 * The admin bootstrap identity used to RUN ferry. Root .env only — an
 * integration folder may never set these.
 */
export const AWS_CREDENTIAL_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
] as const;

export const awsCredentialsSchema = z.object({
  AWS_ACCESS_KEY_ID: nonEmpty,
  AWS_SECRET_ACCESS_KEY: nonEmpty,
  AWS_SESSION_TOKEN: z.string().optional(),
  AWS_REGION: nonEmpty,
});

export type AwsCredentials = z.infer<typeof awsCredentialsSchema>;
