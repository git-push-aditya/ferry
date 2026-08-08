import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Integration } from "./define";
import { FerryError } from "./errors";

export interface DiscoveredIntegration {
  /** Derived from the folder path, e.g. "snowflake/s3-storage-integration". */
  id: string;
  /** Absolute path of the folder — also where its .env lives. */
  dir: string;
  manifestPath: string;
  integration: Integration<any>;
}

const MANIFEST = "integration.ts";

/** Walks the tree looking for `integration.ts`; a folder that has one is a leaf. */
async function findManifests(root: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }

  if (dirents.some((d) => d.isFile() && d.name === MANIFEST)) {
    return [path.join(root, MANIFEST)];
  }

  const nested = await Promise.all(
    dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
      .map((d) => findManifests(path.join(root, d.name))),
  );
  return nested.flat();
}

/**
 * Finds every integration by walking `integrationsDir` for `integration.ts`.
 *
 * There is deliberately no central list to edit: adding an integration is
 * creating a folder, and nothing else. If discovery ever needs a registry
 * import, the extensibility promise is broken.
 */
export async function discoverIntegrations(
  integrationsDir: string,
): Promise<DiscoveredIntegration[]> {
  const manifests = (await findManifests(integrationsDir)).sort();

  const found: DiscoveredIntegration[] = [];
  for (const manifestPath of manifests) {
    const dir = path.dirname(manifestPath);
    const id = path.relative(integrationsDir, dir).split(path.sep).join("/");

    const mod = (await import(pathToFileURL(manifestPath).href)) as {
      default?: Integration<any>;
    };
    const integration = mod.default;
    if (!integration || typeof integration !== "object" || !Array.isArray(integration.steps)) {
      throw new FerryError(`${manifestPath} must default-export a defineIntegration({...}) manifest`);
    }
    if (integration.id !== id) {
      throw new FerryError(
        `Integration id "${integration.id}" does not match its folder path "${id}"`,
        [`Manifest: ${manifestPath}`, "The id must be the folder path under integrations/."],
      );
    }

    found.push({ id, dir, manifestPath, integration });
  }

  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.id)) throw new FerryError(`Duplicate integration id "${f.id}"`);
    seen.add(f.id);
  }

  return found;
}

export async function findIntegration(
  integrationsDir: string,
  id: string,
): Promise<DiscoveredIntegration> {
  const all = await discoverIntegrations(integrationsDir);
  const match = all.find((i) => i.id === id);
  if (!match) {
    throw new FerryError(`No integration with id "${id}"`, [
      "Available:",
      ...all.map((i) => `  - ${i.id} — ${i.integration.summary}`),
    ]);
  }
  return match;
}
