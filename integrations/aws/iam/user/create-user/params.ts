import { z } from "zod";
import { nonEmpty } from "../../../../../src/core/env";

/**
 * Folder-scoped params only — no credentials. `IAM_USER_PATH` and
 * `IAM_PERMISSIONS_BOUNDARY_ARN` are optional: a plain user with no path
 * (AWS default "/") and no boundary is the common case.
 */
export const paramsSchema = z.object({
  IAM_USER_NAME: nonEmpty,
  IAM_USER_PATH: z.string().optional(),
  IAM_PERMISSIONS_BOUNDARY_ARN: z.string().optional(),
});

export type Params = z.infer<typeof paramsSchema>;
