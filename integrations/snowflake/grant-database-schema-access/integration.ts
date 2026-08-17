import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { grantAccessStep } from "./steps/grant-access";
import { verify } from "./verify";

/**
 * Converges an existing Snowflake role's privileges on an existing database
 * or schema to a declared desired set.
 *
 * Both the role and the target database/schema are real preconditions this
 * integration does not create — see README.
 */
export default defineIntegration<Params>({
  id: "snowflake/grant-database-schema-access",
  schemaVersion: 1,
  summary:
    "Converges an existing role's privileges on an existing database/schema to a declared desired set.",

  // DESIRED_PRIVILEGES and PRUNE_UNMANAGED_PRIVILEGES transform the
  // .env-facing string input into an array/boolean output, so the input and
  // output types differ — the same ZodEffects shape aws/s3/create-bucket's
  // params cast for, which z.ZodType<P>'s default same-Input-as-Output
  // generic doesn't model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["snowflake"],

  steps: [connectStep, grantAccessStep],

  verify,

  reportName: (ctx) => `${ctx.params.ROLE_NAME}-${ctx.params.OBJECT_TYPE}-${ctx.params.OBJECT_NAME}`,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Privilege Grant — \`${p.ROLE_NAME}\` on ${p.OBJECT_TYPE} \`${p.OBJECT_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/grant-database-schema-access\`.

## Grant

- Role: \`${p.ROLE_NAME}\`
- Object: ${p.OBJECT_TYPE} \`${p.OBJECT_NAME}\`
- Desired privileges: ${p.DESIRED_PRIVILEGES.join(", ")}
- Prune unmanaged privileges: ${p.PRUNE_UNMANAGED_PRIVILEGES ? "yes" : "no (additive only)"}

## Verification

Verified — \`SHOW GRANTS ON ${p.OBJECT_TYPE} ${p.OBJECT_NAME}\` includes every desired privilege for \`${p.ROLE_NAME}\`.
`;
  },
});
