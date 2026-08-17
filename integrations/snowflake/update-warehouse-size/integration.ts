import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { resizeStep } from "./steps/resize";
import { verify } from "./verify";

/**
 * Resizes an existing Snowflake warehouse. Never creates one — that's
 * create-warehouse's job — so this integration's real precondition is that
 * the warehouse already exists.
 */
export default defineIntegration<Params>({
  id: "snowflake/update-warehouse-size",
  schemaVersion: 1,
  summary:
    "Resizes an existing Snowflake warehouse to a target size. Non-disruptive to in-flight queries, unlike an EC2 instance-type resize.",

  params: paramsSchema,
  credentials: ["snowflake"],

  steps: [connectStep, resizeStep],

  verify,

  reportName: (ctx) => ctx.params.WAREHOUSE_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Warehouse Resize — \`${p.WAREHOUSE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/update-warehouse-size\`.

## Resize

- Warehouse: \`${p.WAREHOUSE_NAME}\`
- Target size: \`${p.TARGET_SIZE}\`

Resizing a Snowflake warehouse does not disrupt currently-executing
statements — running queries finish on their existing compute, and the new
size applies only to statements that start afterward. This is unlike
resizing an AWS EC2 instance, which requires a stop/start.

## Verification

Verified — \`SHOW WAREHOUSES\` confirms the warehouse now reports \`${p.TARGET_SIZE}\`.
`;
  },
});
