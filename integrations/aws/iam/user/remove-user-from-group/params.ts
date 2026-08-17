import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,
  IAM_GROUP_NAME: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;
