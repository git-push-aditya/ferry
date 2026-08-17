import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { terminateStep } from "./steps/terminate";
import { verify } from "./verify";

/**
 * Terminates an EC2 instance. Irreversible — rollback logs a warning, it does
 * not attempt to recreate anything, since a replacement instance would get a
 * new instanceId regardless.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/terminate-instance",
  schemaVersion: 1,
  summary: "Terminates an EC2 instance, aborting instead of proceeding if a preserved volume would be stranded.",

  // PRESERVE_VOLUME_CHECK arrives as "true"/"false" and is transformed to a
  // boolean — same ZodEffects Input != Output shape as create-bucket's
  // boolFlag.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [terminateStep],

  verify,

  reportName: (ctx) => ctx.params.INSTANCE_ID,

  report(ctx) {
    const p = ctx.params;
    return `# EC2 Instance Termination — \`${p.INSTANCE_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/terminate-instance\`.

## Instance

- Id: \`${p.INSTANCE_ID}\`
- Pre-terminate AMI: \`${ctx.outputs.amiId ?? "(unknown)"}\`
- Pre-terminate instance type: \`${ctx.outputs.instanceType ?? "(unknown)"}\`
- Pre-terminate subnet: \`${ctx.outputs.subnetId ?? "(unknown)"}\`
- Pre-terminate security groups: \`${ctx.outputs.securityGroupIds ?? "(unknown)"}\`

## Verification

Verified — confirmed the instance is terminated (or already purged).

## Note

This action is irreversible. Rollback, if triggered by a later step's
failure, only logs a warning — it cannot recover this instance.
`;
  },
});
