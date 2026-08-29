import { readFile } from "node:fs/promises";
import { z } from "zod";
import { FerryError } from "./errors";

/**
 * Prints every offending key at once — not just the first — then exits before
 * any API call is made. Fail-fast env validation is the cheapest failure mode
 * this tool has, so it stays a hard exit rather than a throw.
 */
export function fail(errors: z.ZodError): never {
  const keys = [...new Set(errors.issues.map((i) => i.path.join(".")))];
  console.error("Missing or invalid environment variables:");
  for (const k of keys) console.error(`  - ${k}`);
  process.exit(1);
}

export const nonEmpty = z.string().min(1, "must not be empty");

/** Validates `source` against `schema`, or lists every bad key and exits 1. */
export function parseOrExit<T>(schema: z.ZodType<T>, source: unknown): T {
  const result = schema.safeParse(source);
  if (!result.success) fail(result.error);
  return result.data;
}

/**
 * Minimal .env parser. Deliberately not a dependency: folder .env files hold
 * plain resource names, so the surface we need is `KEY=value`, `#` comments,
 * optional `export `, and optional quoting.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n");
    } else {
      // An unquoted trailing comment is not part of the value.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

/** Reads and parses a .env file; returns null when the file does not exist. */
export async function readEnvFile(filePath: string): Promise<Record<string, string> | null> {
  try {
    return parseEnvFile(await readFile(filePath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
}

export interface EnvLayerInput<C, P> {
  /**
   * Where credentials come from — normally `process.env`, which bun has
   * already populated from the root .env.
   */
  credentialSource: Record<string, string | undefined>;
  /** Parsed contents of the integration folder's own .env. */
  folderSource: Record<string, string>;
  /** Path of that folder .env, used only to make the error message actionable. */
  folderEnvPath: string;
  /**
   * Every key that is a credential anywhere in the provider registry — not just
   * the ones this integration declares. A folder .env may not set any of them,
   * whichever provider they belong to.
   */
  credentialKeys: readonly string[];
  credentialSchema: z.ZodType<C>;
  paramsSchema: z.ZodType<P>;
}

export interface EnvLayers<C, P> {
  creds: C;
  params: P;
}

/**
 * Two layers, strictly separated:
 *
 * - **Root .env → credentials.** Shared by every integration.
 * - **Folder .env → params.** Resource names and toggles for one integration.
 *
 * Params are never inherited from the root layer: an integration folder is
 * standalone, so if two integrations both need EXPORT_S3_BUCKET they each
 * declare it. The duplication is the point — it keeps a folder copy-able.
 *
 * The reverse leak is an outright error: a folder .env that sets a credential
 * key would let a checked-out integration silently redirect the run at another
 * AWS account or Snowflake, so it fails loudly instead of being ignored.
 */
export function loadEnvLayers<C, P>(input: EnvLayerInput<C, P>): EnvLayers<C, P> {
  const credentialKeys = new Set(input.credentialKeys);
  const offending = Object.keys(input.folderSource).filter((k) => credentialKeys.has(k));
  if (offending.length) {
    throw new FerryError(
      `Credential keys are not allowed in an integration's .env — move them to the root .env.`,
      [
        `File: ${input.folderEnvPath}`,
        ...offending.map((k) => `  - ${k}`),
        "An integration folder declares params only; credentials are always root-scoped.",
      ],
    );
  }

  // Both layers are validated before either is allowed to fail, so one run
  // surfaces every offending key across both files — not the root's, then the
  // folder's on the next attempt.
  const credResult = input.credentialSchema.safeParse(input.credentialSource);
  const paramResult = input.paramsSchema.safeParse(input.folderSource);
  if (!credResult.success || !paramResult.success) {
    fail(
      new z.ZodError([
        ...(credResult.success ? [] : credResult.error.issues),
        ...(paramResult.success ? [] : paramResult.error.issues),
      ]),
    );
  }

  return { creds: credResult.data, params: paramResult.data };
}

/**
 * `.env` carries strings, so a boolean param arrives as "true"/"false" and a
 * list arrives as a JSON string. Both helpers live here rather than beside a
 * provider because neither knows anything about any provider -- they are the
 * shape of the `.env` layer itself.
 *
 * Note the consequence for integrations that use them: the schema's Input type
 * stops matching its Output type, which `z.ZodType<P>` cannot model, so those
 * integrations cast their schema in `integration.ts`.
 */
export function boolFlag(defaultValue: "true" | "false") {
  return z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");
}

export function jsonArrayParam<T>(label: string, itemSchema: z.ZodType<T>, defaultValue = "[]") {
  return z
    .string()
    .optional()
    .default(defaultValue)
    .transform((v, ctx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be valid JSON` });
        return z.NEVER;
      }
      if (!Array.isArray(parsed)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a JSON array` });
        return z.NEVER;
      }
      const items: T[] = [];
      parsed.forEach((entry, index) => {
        const result = itemSchema.safeParse(entry);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label}[${index}] is invalid: ${result.error.issues.map((i) => i.message).join(", ")}`,
          });
          return;
        }
        items.push(result.data);
      });
      return items;
    });
}
