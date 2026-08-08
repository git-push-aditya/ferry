import type { ProviderRegistry } from "../core/provider";
import { awsProvider } from "./aws";
import { snowflakeProvider } from "./snowflake";

/**
 * The provider registry, handed to the engine from outside so `src/core/` never
 * imports a concrete provider.
 *
 * This is a registry of *credential kinds*, not of integrations — adding an
 * integration never touches this file.
 */
export const providers: ProviderRegistry = {
  [awsProvider.id]: awsProvider,
  [snowflakeProvider.id]: snowflakeProvider,
};
