import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

export const paramsSchema = z.object({
  // The service principal string, e.g. "elasticbeanstalk.amazonaws.com" —
  // case-sensitive, exactly as AWS's own service-linked-role docs list it.
  AWS_SERVICE_NAME: nonEmpty,

  // Required, deliberately: per-service naming/uniqueness variance for
  // service-linked roles is not uniform (some are singleton-per-account, some
  // support CustomSuffix for multiple instances), and is not enumerated by a
  // single master list in the IAM API reference. Rather than have Ferry guess
  // the resolved role name client-side, the caller looks it up ahead of time
  // from AWS's own per-service service-linked-role documentation and supplies
  // it here — this is the load-bearing safety mechanism for check().
  EXPECTED_ROLE_NAME: nonEmpty,

  CUSTOM_SUFFIX: z.string().optional(),
  DESCRIPTION: z.string().optional(),
});

export type Params = z.infer<typeof paramsSchema>;
