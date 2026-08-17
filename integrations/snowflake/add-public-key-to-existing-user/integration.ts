import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { addKeyStep } from "./steps/add-key";
import { connectStep } from "./steps/connect";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "snowflake/add-public-key-to-existing-user",
  schemaVersion: 1,
  summary:
    "Attaches an additional RSA public key to an already-provisioned Snowflake user, into whichever key slot is free.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, addKeyStep],

  verify,

  reportName: (ctx) => ctx.params.USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const slot = String(ctx.outputs.targetKeySlot ?? "?");
    return `# Snowflake Add Public Key — \`${p.USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/add-public-key-to-existing-user\`.

## What happened

- User: \`${p.USER_NAME}\`
- Slot written: \`${slot}\` (\`${slot === "2" ? "RSA_PUBLIC_KEY_2" : "RSA_PUBLIC_KEY"}\`)

## Verification

\`DESC USER ${p.USER_NAME}\` shows a populated fingerprint for the slot above.
`;
  },
});
