import type { z } from "zod";

/**
 * A provider owns one credential kind: the schema for its slice of the root
 * .env, the clients built from those credentials, and (optionally) an identity
 * probe plus teardown.
 *
 * Core never imports a concrete provider — the registry is handed to the engine
 * from the outside, so `src/core/` stays free of anything AWS-, S3-, or
 * Snowflake-specific.
 */
export interface ProviderDef<C = unknown> {
  /** Matches the `credentials: [...]` entries an integration declares, e.g. "aws". */
  id: string;

  /** The keys this provider claims in the root .env. Used to reject folder .env overrides. */
  credentialKeys: readonly string[];

  /** Validates this provider's slice of the root .env. */
  credentialSchema: z.ZodTypeAny;

  /** Builds the clients steps will use. Must not perform I/O. */
  createClients(creds: Record<string, unknown>): C;

  /**
   * Read-only identity probe, run once by the engine before the plan phase.
   * `accountId` (when returned) is surfaced as `ctx.accountId`.
   */
  resolveIdentity?(clients: C): Promise<{ accountId?: string; description: string }>;

  /**
   * Released after rollback has run, on every exit path. Rollback may still
   * need a live connection (dropping Snowflake objects), so teardown is always
   * last.
   */
  dispose?(clients: C): Promise<void>;
}

export type ProviderRegistry = Record<string, ProviderDef<unknown>>;

/** Every credential key across the whole registry, not just the declared kinds. */
export function allCredentialKeys(registry: ProviderRegistry): string[] {
  return Object.values(registry).flatMap((p) => [...p.credentialKeys]);
}
