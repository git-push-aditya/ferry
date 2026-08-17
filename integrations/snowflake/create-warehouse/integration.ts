import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { connectStep } from "./steps/connect";
import { warehouseStep } from "./steps/warehouse";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "snowflake/create-warehouse",
  schemaVersion: 1,
  summary: "Creates a Snowflake warehouse, initially suspended, with a given size and auto-suspend/resume policy.",

  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["snowflake"],

  steps: [connectStep, warehouseStep],

  verify,

  reportName: (ctx) => ctx.params.WAREHOUSE_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Snowflake Warehouse — \`${p.WAREHOUSE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry snowflake/create-warehouse\`.

## Warehouse

- Name: \`${p.WAREHOUSE_NAME}\`
- Size: \`${p.WAREHOUSE_SIZE}\`
- Auto-suspend: \`${p.AUTO_SUSPEND_SECONDS}s\`
- Auto-resume: \`${p.AUTO_RESUME}\`
- Created initially suspended — it will not start consuming credits until something resumes it.

## Verification

Verified — \`SHOW WAREHOUSES\` confirms the warehouse exists with the requested size, auto_suspend, and auto_resume.
`;
  },
});
