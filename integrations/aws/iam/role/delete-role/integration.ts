import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { roleArn } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { deleteRoleStep } from "./steps/delete-role";
import { verify } from "./verify";

/**
 * Deletes an ordinary IAM role, detaching every managed policy, deleting
 * every inline policy, and removing it from every instance profile first —
 * DeleteRole's own documented precondition. Refuses (rather than silently
 * failing partway) on a service-linked role; that needs the async
 * DeleteServiceLinkedRole flow, a separate task.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/delete-role",
  schemaVersion: 1,
  summary:
    "Deletes an IAM role after detaching its managed policies, inline policies, and instance profile memberships.",

  // The .env-facing input differs from the parsed output
  // (DELETE_INSTANCE_PROFILES_TOO arrives as a "true"/"false" string), a real
  // ZodEffects shape that z.ZodType<P>'s same-Input-as-Output generic doesn't
  // model. Same cast create-bucket's integration.ts already uses.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [deleteRoleStep],

  verify,

  reportName: (ctx) => ctx.params.ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const arn = String(ctx.outputs.roleArn ?? roleArn(ctx.accountId, p.ROLE_NAME));
    const detachedPolicyArns = (ctx.outputs.detachedPolicyArns as string[] | undefined) ?? [];
    const deletedInlinePolicies =
      (ctx.outputs.deletedInlinePolicies as { policyName: string }[] | undefined) ?? [];
    const removedInstanceProfileNames =
      (ctx.outputs.removedInstanceProfileNames as string[] | undefined) ?? [];
    const deletedInstanceProfileNames =
      (ctx.outputs.deletedInstanceProfileNames as string[] | undefined) ?? [];

    return `# IAM Role Deletion — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/delete-role\`.

## AWS IAM

- Role name: \`${p.ROLE_NAME}\`
- Role ARN: \`${arn}\`

## What was cleaned up

- Detached managed policies: ${detachedPolicyArns.length ? detachedPolicyArns.map((a) => `\`${a}\``).join(", ") : "(none)"}
- Deleted inline policies: ${deletedInlinePolicies.length ? deletedInlinePolicies.map((p2) => `\`${p2.policyName}\``).join(", ") : "(none)"}
- Removed from instance profiles: ${removedInstanceProfileNames.length ? removedInstanceProfileNames.map((n) => `\`${n}\``).join(", ") : "(none)"}
- Instance profiles also deleted: ${p.DELETE_INSTANCE_PROFILES_TOO ? (deletedInstanceProfileNames.length ? deletedInstanceProfileNames.map((n) => `\`${n}\``).join(", ") : "(none — all had other roles attached)") : "not requested (DELETE_INSTANCE_PROFILES_TOO=false)"}

## Rollback caveat

If this run is rolled back, the role is recreated from a pre-delete snapshot
on a best-effort basis only. The recreated role gets a **new RoleId**, so any
resource policy or trust relationship keyed on the old RoleId will not
automatically re-authorize, and any activity history or state the linked
service itself held is not recoverable.

## Verification

Verified — confirmed \`GetRole\` throws \`NoSuchEntityException\` for
\`${p.ROLE_NAME}\`.
`;
  },
});
