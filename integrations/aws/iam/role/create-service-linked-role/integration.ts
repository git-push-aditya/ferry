import { defineIntegration } from "../../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { serviceLinkedRoleStep } from "./steps/service-linked-role";
import { verify } from "./verify";

/**
 * Creates a service-linked role for AWS_SERVICE_NAME, or skips if
 * EXPECTED_ROLE_NAME already exists. Unlike create-role, this creates its
 * own role via a wholly separate creation path — AWS chooses the trust
 * policy, path and permission set, none of which the caller controls — so
 * there is no guard step here.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/create-service-linked-role",
  schemaVersion: 1,
  summary:
    "Creates (or confirms) a service-linked role for a given AWS service, using a caller-supplied EXPECTED_ROLE_NAME to sidestep per-service naming variance.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [serviceLinkedRoleStep],

  verify,

  reportName: (ctx) => ctx.params.EXPECTED_ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const createdThisRun = Boolean(ctx.outputs.serviceLinkedRoleCreatedThisRun);
    const arn = String(ctx.outputs.roleArn ?? "(not created this run — role already existed)");

    return `# Service-Linked Role — \`${p.EXPECTED_ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/create-service-linked-role\`.

## Role

- Expected name: \`${p.EXPECTED_ROLE_NAME}\`
- AWS service: \`${p.AWS_SERVICE_NAME}\`
- Custom suffix: \`${p.CUSTOM_SUFFIX ?? "(none)"}\`
- ARN: \`${arn}\`
- Created this run: ${createdThisRun ? "yes" : "no (already existed)"}

## Verification

Verified — confirmed \`${p.EXPECTED_ROLE_NAME}\` exists and its Path starts
with \`/aws-service-role/\`.
`;
  },
});
