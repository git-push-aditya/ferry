import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

export const paramsSchema = z.object({
  INSTANCE_ID: nonEmpty,
  TARGET_INSTANCE_TYPE: nonEmpty,
});

export type Params = z.infer<typeof paramsSchema>;
