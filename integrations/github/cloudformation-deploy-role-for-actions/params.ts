import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { roleArn } from "../../../src/providers/aws";

/** Folder .env values are always strings — same shape as delete-role's boolFlag. */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

/** Comma-separated, like rotate-role-permissions' DESIRED_POLICY_ARNS — the complete target set, not a delta. */
const arnList = nonEmpty.transform((v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

export const paramsSchema = z.object({
  // This integration never creates or modifies the CI/OIDC role itself —
  // run github/setup-github-actions-oidc-role first. See README.
  AWS_ROLE_NAME: nonEmpty,

  CFN_EXECUTION_ROLE_NAME: nonEmpty,
  // What CloudFormation is actually allowed to create/modify mid-deploy —
  // this integration does not invent a minimal enumerated policy for
  // arbitrary stacks (there is no universal minimal set); the caller
  // supplies whatever managed policies fit what their stacks manage.
  EXECUTION_POLICY_ARNS: arnList,

  // Constrains the CI role's cloudformation:* grant to stacks whose name
  // starts with this prefix, e.g. "myapp-" -> stack/myapp-*/*.
  STACK_NAME_PREFIX: nonEmpty,

  ALLOW_DESTRUCTIVE_ROLLBACK: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;

export function cfnExecutionTrustPolicy(): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "cloudformation.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

/**
 * The CI role's own policy: cloudformation:* scoped to a stack-name-prefix
 * ARN pattern, plus the iam:PassRole grant to the execution role — gated on
 * PassedToService so the CI role can only ever hand this specific role to
 * CloudFormation, not to any other service. This PassRole condition is the
 * single most commonly *missing* permission in hand-rolled CI setups (teams
 * grant cloudformation:* and then hit AccessDenied on iam:PassRole at
 * deploy time) — it is never omitted here.
 */
export function ciRoleCfnPolicyDocument(accountId: string, region: string, p: Params): object {
  const stackArnPattern = `arn:aws:cloudformation:${region}:${accountId}:stack/${p.STACK_NAME_PREFIX}*/*`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "CloudFormationDeploy",
        Effect: "Allow",
        Action: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResources",
          "cloudformation:GetTemplate",
        ],
        Resource: stackArnPattern,
      },
      {
        Sid: "PassExecutionRoleToCloudFormation",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: roleArn(accountId, p.CFN_EXECUTION_ROLE_NAME),
        Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
      },
    ],
  };
}

export function ciRolePolicyName(): string {
  return "ferry-cloudformation-deploy";
}
