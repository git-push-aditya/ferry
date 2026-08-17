import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { launchStep } from "./steps/launch";
import { verify } from "./verify";

/**
 * Launches exactly one EC2 instance, tagged with this integration's identity
 * so a re-run finds it instead of launching a second one. Never changes an
 * already-launched instance's type/AMI/subnet — see the README.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/launch-instance",
  schemaVersion: 1,
  summary:
    "Launches an EC2 instance tagged with a ferry identity pair, proven running and status-ok.",

  // TAGS arrives as a JSON string and is parsed into Record<string,string>
  // here — same ZodEffects Input != Output shape as create-bucket's boolFlag.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [launchStep],

  verify,

  reportName: (ctx) => ctx.params.LOGICAL_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# EC2 Instance — \`${p.LOGICAL_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/launch-instance\`.

## Instance

| Field | Value |
| --- | --- |
| Logical name | \`${p.LOGICAL_NAME}\` |
| AMI | \`${p.AMI_ID}\` |
| Instance type | \`${p.INSTANCE_TYPE}\` |
| Subnet | \`${p.SUBNET_ID}\` |
| Security groups | \`${p.SECURITY_GROUP_IDS.join(", ")}\` |

## Verification

Verified — confirmed the instance reached \`running\` and its status checks
report \`ok\`.
`;
  },
});
