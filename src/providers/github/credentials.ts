import { z } from "zod";
import { nonEmpty } from "../../core/env";

/**
 * A fine-grained PAT or classic token used to run ferry against GitHub —
 * root .env only, same "bootstrap identity" role AWS_ACCESS_KEY_ID plays for
 * AWS. GitHub App installation-token rotation is a phase-2b concern (see
 * docs/plan/github.md's provider-module note), not handled here.
 */
export const GITHUB_CREDENTIAL_KEYS = ["GITHUB_TOKEN"] as const;

export const githubCredentialsSchema = z.object({
  GITHUB_TOKEN: nonEmpty,
});

export type GithubCredentials = z.infer<typeof githubCredentialsSchema>;
