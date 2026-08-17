import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { stopStartStep } from "./steps/stop-start";
import { verify } from "./verify";

/**
 * Stops or starts a single existing EC2 instance — one integration,
 * parameterized by `ACTION`, rather than two near-identical
 * `stop-instance`/`start-instance` integrations. Both directions are
 * genuine, reversible lifecycle transitions, so rollback here is a real
 * undo (unlike `terminate-instance`).
 */
export default defineIntegration<Params>({
  id: "aws/ec2/stop-start-instance",
  schemaVersion: 1,
  summary: "Stops or starts an existing EC2 instance and confirms the destination state.",

  params: paramsSchema,
  credentials: ["aws"],

  steps: [stopStartStep],

  verify,

  reportName: (ctx) => ctx.params.INSTANCE_ID,

  report(ctx) {
    const p = ctx.params;
    const destination = p.ACTION === "stop" ? "stopped" : "running";
    return `# Stop/Start Instance — \`${p.INSTANCE_ID}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/stop-start-instance\`.

## Setting

- Instance: \`${p.INSTANCE_ID}\`
- Action: \`${p.ACTION}\`

## Verification

Verified — confirmed the instance's state is \`${destination}\`.
`;
  },
});
