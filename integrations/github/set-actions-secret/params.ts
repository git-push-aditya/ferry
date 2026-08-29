import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";
import { boolFlag, githubOwner, githubRepoName, jsonArrayParam } from "../../../src/providers/github/params";

/**
 * One integration, three scopes. GitHub's Actions-secrets API is the same
 * shape at repo, org and environment level -- same public-key fetch, same
 * sealed-box encryption, same write-blind GET -- and `SecretScope` in
 * `src/providers/github/secrets.ts` already models exactly that union. Three
 * folders for one API was three copies of the libsodium handling.
 *
 * The scope-specific fields are validated conditionally rather than with a
 * discriminated union, because every value arrives from `.env` as a string
 * and a discriminated union over coerced fields reports its errors against
 * the wrong branch.
 */
export const paramsSchema = z
  .object({
    SCOPE: z.enum(["repo", "org", "environment"]),

    SECRET_NAME: nonEmpty,
    // Never logged, never written to resource()/ctx.outputs beyond this run's
    // own process memory -- same hygiene as AWS access keys and Snowflake
    // key-pairs elsewhere in this project.
    SECRET_VALUE: nonEmpty,
    // Escape hatch for callers who want to guarantee a fresh value regardless
    // of the presence check -- see README for why the default is false.
    FORCE_ROTATE: boolFlag("false"),

    // SCOPE=repo | environment
    OWNER: githubOwner.optional(),
    REPO: githubRepoName.optional(),
    // SCOPE=environment
    ENVIRONMENT_NAME: nonEmpty.optional(),
    // SCOPE=org
    ORG: nonEmpty.optional(),
    VISIBILITY: z.enum(["all", "private", "selected"]).default("private"),
    // Only meaningful when VISIBILITY=selected. Repo database ids, not names --
    // GitHub's own selected-repositories API keys on id.
    SELECTED_REPOSITORY_IDS: jsonArrayParam("SELECTED_REPOSITORY_IDS", z.coerce.number().int()),
  })
  .superRefine((p, ctx) => {
    const require = (key: "OWNER" | "REPO" | "ENVIRONMENT_NAME" | "ORG") => {
      if (!p[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when SCOPE=${p.SCOPE}`,
        });
      }
    };
    if (p.SCOPE === "repo" || p.SCOPE === "environment") {
      require("OWNER");
      require("REPO");
    }
    if (p.SCOPE === "environment") require("ENVIRONMENT_NAME");
    if (p.SCOPE === "org") require("ORG");
  });

export type Params = z.infer<typeof paramsSchema>;

/** Narrow the optional params down to the `SecretScope` this run addresses. */
export function scopeOf(p: Params) {
  switch (p.SCOPE) {
    case "repo":
      return { kind: "repo" as const, owner: p.OWNER!, repo: p.REPO! };
    case "org":
      return { kind: "org" as const, org: p.ORG! };
    case "environment":
      return {
        kind: "environment" as const,
        owner: p.OWNER!,
        repo: p.REPO!,
        environment: p.ENVIRONMENT_NAME!,
      };
  }
}

/** Human-readable target, used in logs, resource names and the report. */
export function targetOf(p: Params): string {
  switch (p.SCOPE) {
    case "repo":
      return `${p.OWNER}/${p.REPO}`;
    case "org":
      return p.ORG!;
    case "environment":
      return `${p.OWNER}/${p.REPO}:${p.ENVIRONMENT_NAME}`;
  }
}
