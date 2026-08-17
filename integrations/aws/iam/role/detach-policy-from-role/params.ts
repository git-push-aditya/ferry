import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Same shape as attach-policy-to-role — a single full ARN, whether the policy
 * is AWS-managed or customer-managed (resolve the latter with
 * `policyArn(accountId, name)` before writing it here).
 */
export const paramsSchema = z.object({
  ROLE_NAME: nonEmpty,
  POLICY_ARN: nonEmpty.refine((v) => /^arn:aws:iam::(\d{12}|aws):policy\/.+/.test(v), {
    message: "must look like arn:aws:iam::<account-id-or-aws>:policy/<name>",
  }),
});

export type Params = z.infer<typeof paramsSchema>;
