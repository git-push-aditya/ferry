import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { ecrRepositoryArn } from "../../../src/providers/aws";

/** Folder .env values are always strings — same shape as delete-role's boolFlag. */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  // This integration never creates or modifies the OIDC role itself — run
  // github/setup-github-actions-oidc-role first. See README.
  AWS_ROLE_NAME: nonEmpty,

  ECR_REPOSITORY_NAME: nonEmpty,
  // IMMUTABLE by default — the safer default for a CI-pushed image registry
  // (a tag can't be silently overwritten once pushed), same instinct as
  // create-deploy-key's read_only default.
  IMAGE_TAG_MUTABILITY: z.enum(["MUTABLE", "IMMUTABLE"]).default("IMMUTABLE"),

  ALLOW_DESTRUCTIVE_ROLLBACK: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;

export function inlinePolicyName(repositoryName: string): string {
  return `ferry-ecr-push-${repositoryName}`;
}

/**
 * ecr:GetAuthorizationToken cannot be resource-scoped at all — a resource
 * ARN there is a silent no-op, so it is hardcoded to "*" and never exposed
 * as a configurable param (a real, easy-to-make mistake this design avoids).
 */
export function ecrPushPolicyDocument(accountId: string, region: string, repositoryName: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "EcrAuthToken",
        Effect: "Allow",
        Action: "ecr:GetAuthorizationToken",
        Resource: "*",
      },
      {
        Sid: "EcrPushToRepo",
        Effect: "Allow",
        Action: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
          "ecr:BatchGetImage",
        ],
        Resource: ecrRepositoryArn(accountId, region, repositoryName),
      },
    ],
  };
}
