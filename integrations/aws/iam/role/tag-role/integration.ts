import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { iamRoleExistsGuardStep } from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { tagsStep } from "./steps/tags";
import { verify } from "./verify";

/**
 * Sets a role's tags on a role that already exists. Does not create the
 * role; run `aws/iam/role/create-role` first if it doesn't exist yet.
 */
export default defineIntegration<Params>({
  id: "aws/iam/role/tag-role",
  schemaVersion: 1,
  summary: "Sets an existing IAM role's tags to an exact desired set, proven with a live read-back.",

  // .default("") makes the .env-facing input optional even though the
  // parsed output is always a string — same ZodEffects shape create-bucket's
  // boolean flags hit.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [iamRoleExistsGuardStep<Params>({ roleName: (p) => p.ROLE_NAME }), tagsStep],

  verify,

  reportName: (ctx) => ctx.params.ROLE_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# Role Tags — \`${p.ROLE_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/role/tag-role\`.

## Setting

- Role: \`${p.ROLE_NAME}\`
- Tags: ${p.TAGS_JSON ? `\`${p.TAGS_JSON}\`` : "not managed by ferry"}

## Verification

Verified — read the role's tags back and confirmed every desired tag is
present.
`;
  },
});
