import type { z } from "zod";
import type { Logger } from "./logger";

/**
 * What a `check()` found. Deliberately three-valued: "the resource is there but
 * isn't ours" is a different situation from "it isn't there", and conflating
 * them is how a run ends up trying to create something it can't.
 *
 * `check()` is a *shallow presence/ownership* probe. It is not drift detection:
 * ferry's job ends at "exists and is verified working", so a step must never
 * grow into a field-by-field diff.
 */
export type StepState = "missing" | "exists" | "conflict";

export type StepOutputs = Record<string, unknown>;

/** Clients keyed by provider id, built by the engine from the root credentials. */
export type ProviderClients = Record<string, unknown>;

export interface StepContext<P> {
  /** Validated params from the integration folder's .env. Never credentials. */
  params: P;
  /** Validated credentials from the root .env. Never from params. */
  creds: Record<string, unknown>;
  /** Provider clients, keyed by provider id. Use the provider's typed accessor. */
  clients: ProviderClients;
  /** Resolved once by the engine, before any step runs. */
  accountId: string;
  /** Outputs accumulated from prior steps. Mutated in place as the run advances. */
  outputs: StepOutputs;
  /** True during `--dry-run`: every check() runs, no create()/reconcile() does. */
  dryRun: boolean;
  log: Logger;
}

/** What the run registry records for a step that actually changed something. */
export interface ResourceRef {
  /** Provider-native type, e.g. "aws_iam_role" or "snowflake_storage_integration". */
  type: string;
  /** Logical name as the user wrote it in the folder .env. */
  name: string;
  /** Identifying attributes — ARN, URL, id. Never secrets. */
  attributes: Record<string, string>;
}

/**
 * Declared in T1, consumed in T3. Populated while porting so the metadata is
 * captured at the point where the resource is actually understood; no emitter
 * exists yet and none should be built here.
 */
export interface StepHandoff<P> {
  terraform?: {
    type: string;
    address: string;
    importId(ctx: StepContext<P>): string;
  };
  ansibleVar?: string;
}

export interface Step<P> {
  id: string;
  title: string;

  /**
   * Read-only. Must never mutate. Runs for every step in the plan phase,
   * including under --dry-run.
   *
   * "conflict" means the resource exists but is not usable by this run (e.g. an
   * S3 bucket name owned by another AWS account) — the engine aborts before any
   * mutation rather than failing halfway.
   */
  check(ctx: StepContext<P>): Promise<StepState>;

  /**
   * Creates the resource. Only called when check() returned "missing".
   * Returns outputs merged into ctx.outputs.
   *
   * Omit it for a step that only reads (e.g. verifying a connection) or that
   * only ever reconciles.
   */
  create?(ctx: StepContext<P>): Promise<StepOutputs>;

  /**
   * Mutates a resource that already exists rather than creating one — patching
   * an IAM role's trust policy, re-pointing a storage integration. Runs
   * whenever create() did not.
   *
   * A reconcile step must capture the prior value in its outputs so that
   * rollback() can put it back: the engine will unwind it like any other change
   * made this run.
   */
  reconcile?(ctx: StepContext<P>): Promise<StepOutputs>;

  /**
   * Undoes this step. Registered only when create() or reconcile() actually
   * ran — a resource that already existed is never rolled back.
   */
  rollback(ctx: StepContext<P>): Promise<void>;

  /** Describes what was created/changed, for the run registry. */
  resource?(ctx: StepContext<P>): ResourceRef;

  handoff?: StepHandoff<P>;
}

export interface Integration<P> {
  /** Folder path under integrations/, e.g. "snowflake/s3-storage-integration". */
  id: string;
  schemaVersion: 1;
  summary: string;
  /** Folder-scoped params ONLY. No credentials. */
  params: z.ZodType<P>;
  /** Provider ids whose credentials the engine loads from the root .env. */
  credentials: string[];
  steps: Step<P>[];
  /** Live functional proof. Throws on failure, which rolls the whole run back. */
  verify(ctx: StepContext<P>): Promise<void>;
  /** Markdown, secrets masked. Written 0600 into output/. */
  report(ctx: StepContext<P>): string;
  /** Report filename stem. Defaults to the integration id with '/' replaced. */
  reportName?(ctx: StepContext<P>): string;
}

export function defineIntegration<P>(i: Integration<P>): Integration<P> {
  return i;
}

/** Reads an output a later step depends on, failing loudly if a step order changed. */
export function requireOutput<T>(ctx: StepContext<unknown>, key: string): T {
  const value = ctx.outputs[key];
  if (value === undefined || value === null) {
    throw new Error(`Expected output "${key}" from an earlier step, but it was not set`);
  }
  return value as T;
}
