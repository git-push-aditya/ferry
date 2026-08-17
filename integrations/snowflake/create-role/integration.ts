import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { roleStep } from "./steps/role";
import { verify } from "./verify";

/**
 * Creates a Snowflake role and, optionally, grants it a starting set of
 * privileges declared as `INITIAL_GRANTS`.
 */
export default defineIntegration<Params>({
  id: "snowflake/create-role",
  schemaVersion: 1,
  summary: "Creates a Snowflake role and grants it an optional initial set of privileges.",

  // INITIAL_GRANTS arrives as a JSON string and is parsed/validated into an
  // array by a transform, so folder-.env Input differs from parsed Output —
  // the same ZodEffects shape as aws/s3/create-bucket's boolFlag params.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["snowflake"],

  steps: [connectStep, roleStep],

  verify,

  reportName: (ctx) => ctx.params.ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    const grantLines = p.INITIAL_GRANTS.length
      ? p.INITIAL_GRANTS.map((g) => `- \`${g.privilege} ON ${g.onType} ${g.onName}\``).join("\n")
      : "- none";

    return `# Snowflake Role — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/create-role\`.

## Role

- Name: \`${p.ROLE_NAME}\`

## Initial grants

${grantLines}

## Verification

Verified — \`SHOW ROLES LIKE '${p.ROLE_NAME}'\` matched, and every declared initial
grant was confirmed present via \`SHOW GRANTS TO ROLE ${p.ROLE_NAME}\`.
`;
  },
});
