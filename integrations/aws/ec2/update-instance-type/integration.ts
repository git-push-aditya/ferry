import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { updateInstanceTypeStep } from "./steps/update-instance-type";
import { verify } from "./verify";

/**
 * Changes an existing EC2 instance's type via the required stop -> modify ->
 * start sequence. If the instance was already stopped before this run, it is
 * left stopped afterward rather than being started as a side effect.
 *
 * Rollback risk: reverting the type after a failed restart can itself fail
 * if the original type is no longer available in the instance's AZ — see
 * README for the full explanation. That is a genuine, unresolvable risk this
 * integration surfaces loudly rather than papering over.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/update-instance-type",
  schemaVersion: 1,
  summary: "Changes an existing EC2 instance's type via stop -> modify -> start, confirmed with a read-back.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [updateInstanceTypeStep],

  verify,

  reportName: (ctx) => ctx.params.INSTANCE_ID,

  report(ctx) {
    const p = ctx.params;
    return `# Update Instance Type — \`${p.INSTANCE_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/update-instance-type\`.

## Setting

- Instance: \`${p.INSTANCE_ID}\`
- Target instance type: \`${p.TARGET_INSTANCE_TYPE}\`

## Verification

Verified — confirmed \`InstanceType\` reads back as \`${p.TARGET_INSTANCE_TYPE}\`, and
that the instance's power state matches whatever this run actually did (left
running if it was originally running, left stopped if it was originally
stopped).
`;
  },
});
