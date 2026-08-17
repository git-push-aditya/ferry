import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * A single ARN param covers both AWS-managed policies (already a full ARN,
 * e.g. `arn:aws:iam::aws:policy/ReadOnlyAccess`) and customer-managed ones —
 * resolve the latter with `policyArn(accountId, name)` from
 * `src/providers/aws/iam.ts` before writing it here. Not over-engineered into
 * a second POLICY_NAME param — same call as attach-policy-to-role.
 */
export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,
  IAM_POLICY_ARN: nonEmpty.refine((v) => /^arn:aws:iam::(\d{12}|aws):policy\/.+/.test(v), {
    message: "must look like arn:aws:iam::<account-id-or-aws>:policy/<name>",
  }),
});

export type Params = z.infer<typeof paramsSchema>;
