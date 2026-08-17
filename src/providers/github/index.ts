import type { ProviderDef } from "../../core/provider";
import { GITHUB_PROVIDER_ID, makeGithubClients, resolveGithubIdentity, type GithubClients } from "./client";
import { GITHUB_CREDENTIAL_KEYS, githubCredentialsSchema, type GithubCredentials } from "./credentials";

export const githubProvider: ProviderDef<GithubClients> = {
  id: GITHUB_PROVIDER_ID,
  credentialKeys: GITHUB_CREDENTIAL_KEYS,
  credentialSchema: githubCredentialsSchema,
  createClients: (creds) => makeGithubClients(creds as GithubCredentials),
  resolveIdentity: (clients) => resolveGithubIdentity(clients),
  // No dispose: a fetch-based REST client holds no connection to release.
};

export * from "./branch-protection";
export * from "./client";
export * from "./collaborators";
export * from "./credentials";
export * from "./errors";
export * from "./params";
export * from "./repos";
export * from "./secrets";
export * from "./webhooks";
