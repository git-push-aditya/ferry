import type { ProviderDef } from "../../core/provider";
import {
  makeSnowflakeClients,
  SNOWFLAKE_PROVIDER_ID,
  type SnowflakeClients,
} from "./client";
import {
  SNOWFLAKE_CREDENTIAL_KEYS,
  snowflakeCredentialsSchema,
  type SnowflakeCredentials,
} from "./credentials";

export const snowflakeProvider: ProviderDef<SnowflakeClients> = {
  id: SNOWFLAKE_PROVIDER_ID,
  credentialKeys: SNOWFLAKE_CREDENTIAL_KEYS,
  credentialSchema: snowflakeCredentialsSchema,
  createClients: (creds) => makeSnowflakeClients(creds as SnowflakeCredentials),
  // No resolveIdentity: connecting is a step, so it gets a plan entry and a
  // banner, and --dry-run exercises the real credential check rather than a
  // separate one.
  dispose: (clients) => clients.close(),
};

export * from "./client";
export * from "./credentials";
export * from "./ddl";
export * from "./params";
