import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { iamRoleExistsGuardStep, roleArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { rotatePermissionsStep } from "./steps/rotate-permissions";
import { verify } from "./verify";

/**
 * Replaces a role's full managed-policy-attachment set in one operation:
 * DESIRED_POLICY_ARNS is the complete target set, not a diff the caller
 * computes themselves — safely computing that diff, with an attach-before-
 * detach fail-safe ordering, is exactly this integration's value.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/rotate-role-permissions",
  schemaVersion: 1,
  summary:
    "Converges an existing IAM role's attached managed policies to exactly DESIRED_POLICY_ARNS, attaching before detaching so the role is never under-permissioned mid-run.",

  // DESIRED_POLICY_ARNS arrives as a comma-separated string and is
  // .transform()-ed into a string array, which breaks z.ZodType<P>'s default
  // same-Input-as-Output generic — cast at the call site, same precedent as
  // aws/s3/create-bucket's boolFlag.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    iamRoleExistsGuardStep<Params>({ roleName: (p) => p.ROLE_NAME }),
    rotatePermissionsStep,
  ],

  verify,

  reportName: (ctx) => ctx.params.ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const executedAttach = JSON.parse((ctx.outputs.executedAttach as string) ?? "[]") as string[];
    const executedDetach = JSON.parse((ctx.outputs.executedDetach as string) ?? "[]") as string[];

    return `# Rotate Role Permissions — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/rotate-role-permissions\`.

## Role

- Name: \`${p.ROLE_NAME}\`
- ARN: \`${roleArn(ctx.accountId, p.ROLE_NAME)}\`

## Desired policy set (complete, not a delta)

${p.DESIRED_POLICY_ARNS.map((a) => `- \`${a}\``).join("\n")}

## This run

- Attached: ${executedAttach.length} (\`${executedAttach.join(", ") || "none"}\`)
- Detached: ${executedDetach.length} (\`${executedDetach.join(", ") || "none"}\`)

## Verification

Verified — polled the role's attached-policy list until it exactly matched
the desired set (as a set, ignoring order).
`;
  },
});
