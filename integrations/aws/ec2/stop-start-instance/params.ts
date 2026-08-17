import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

export const paramsSchema = z.object({
  INSTANCE_ID: nonEmpty,
  // Which direction this run performs — a single two-way toggle rather than
  // two separate integrations, per the plan's own singular naming
  // ("stop-start-instance") — see README for the full reasoning.
  ACTION: z.enum(["stop", "start"]),
});

export type Params = z.infer<typeof paramsSchema>;
