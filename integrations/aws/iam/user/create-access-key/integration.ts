import type { z } from "zod";
import { defineIntegration } from "../../../../../src/core/define";
import { mask } from "../../../../../src/core/report";
import {
  iamAccessKeyStep,
  iamUserExistsGuardStep,
} from "../../../../../src/providers/aws";
import { paramsSchema, type Params } from "./params";
import { verify } from "./verify";

export default defineIntegration<Params>({
  id: "aws/iam/user/create-access-key",
  schemaVersion: 1,
  summary:
    "Mints an access key for an existing IAM user, respecting the 2-key AWS cap, proven with a live sts:GetCallerIdentity call.",

  // The .env-facing input differs from the parsed output (ALLOW_SECOND_KEY
  // arrives as "true"/"false" strings), which is a real, if unusual,
  // ZodEffects shape that z.ZodType<P>'s default same-Input-as-Output generic
  // doesn't model. Same cast as aws/s3/create-bucket's integration.ts.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [
    iamUserExistsGuardStep<Params>({ userName: (p) => p.IAM_USER_NAME }),
    iamAccessKeyStep<Params>({
      userName: (p) => p.IAM_USER_NAME,
      allowSecondKey: (p) => p.ALLOW_SECOND_KEY,
    }),
  ],

  verify,

  reportName: (ctx) => ctx.params.IAM_USER_NAME,

  report(ctx) {
    const p = ctx.params;
    const accessKeyId = String(ctx.outputs.accessKeyId ?? "");
    const secret = String(ctx.outputs.secretAccessKey ?? "");

    // The single point where the full secret is surfaced: stdout, once, after
    // the run is known good. The report below carries only a masked value.
    if (secret) {
      console.log(`
  ── Access key for ${p.IAM_USER_NAME} — full secret shown once ──
  AWS_ACCESS_KEY_ID=${accessKeyId}
  AWS_SECRET_ACCESS_KEY=${secret}

  Copy them into your secret store now. Ferry does not persist the full
  secret; if you lose it, delete the key in IAM and re-run.
`);
    }

    return `# IAM Access Key — \`${p.IAM_USER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/iam/user/create-access-key\`.
> The secret access key is **masked** here. The full secret is not written to
> any file; it was printed to stdout once, at the end of the run that created it.

## IAM

- User name: \`${p.IAM_USER_NAME}\`
- ALLOW_SECOND_KEY: \`${p.ALLOW_SECOND_KEY}\`

## Access key

- AWS_ACCESS_KEY_ID: \`${accessKeyId || "(not created this run — the user already held a key)"}\`
- AWS_SECRET_ACCESS_KEY: \`${secret ? mask(secret) : "(not created this run)"}\`

## Verification

${
  secret
    ? `Verified — called \`sts:GetCallerIdentity\` **as this key** and confirmed it identifies \`${p.IAM_USER_NAME}\`.`
    : `NOT fully verified — no key was minted this run, so there was no new identity to exercise. See the log for why.`
}

## The 2-key cap

AWS hard-caps access keys at 2 per user (\`CreateAccessKey\` beyond that returns
\`LimitExceeded\`) and this is not raisable via a quota increase. This integration
respects that cap directly:

- A user with **0 keys** always gets one minted.
- A user with **1 key** is left alone unless \`ALLOW_SECOND_KEY=true\`, in which
  case a second key is minted (e.g. for a rotation window).
- A user with **2 keys** is always left alone — a third \`create()\` would 409
  regardless of \`ALLOW_SECOND_KEY\`.
`;
  },
});
