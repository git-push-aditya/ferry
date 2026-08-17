import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, jsonArrayParam } from "../../../src/providers/github/params";

export const paramsSchema = z.object({
  ORG: nonEmpty,
  SECRET_NAME: nonEmpty,
  // Never logged, never written to resource()/ctx.outputs beyond this run's
  // own process memory.
  SECRET_VALUE: nonEmpty,
  VISIBILITY: z.enum(["all", "private", "selected"]).default("private"),
  // Only meaningful when VISIBILITY=selected. Repo database ids, not names —
  // GitHub's own selected-repositories API keys on id.
  SELECTED_REPOSITORY_IDS: jsonArrayParam("SELECTED_REPOSITORY_IDS", z.coerce.number().int()),
  FORCE_ROTATE: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;
