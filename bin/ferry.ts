#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverIntegrations, findIntegration } from "../src/core/discover";
import { runIntegration } from "../src/core/engine";
import { FerryError } from "../src/core/errors";
import { error as logError } from "../src/core/logger";
// The entry point is the composition root, so it is the one place that may know
// which providers exist — it already builds the registry.
import { describeAwsError, isAwsError } from "../src/providers/aws";
import { describeGithubError, GithubApiError } from "../src/providers/github";
import { providers } from "../src/providers/registry";

/**
 * PLACEHOLDER ENTRY POINT — not a CLI.
 *
 * Deliberately understands two things and nothing else: one integration id and
 * `--dry-run`. No subcommands, no flag framework, no scaffolder. The real CLI is
 * a later task, and inventing its shape here would lock in the wrong one.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTEGRATIONS_DIR = path.join(ROOT, "integrations");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const id = argv.find((arg) => !arg.startsWith("--"));

  if (!id) {
    const all = await discoverIntegrations(INTEGRATIONS_DIR);
    console.error("Usage: bun bin/ferry.ts <integration-id> [--dry-run]\n");
    console.error("Integrations found:");
    for (const found of all) console.error(`  ${found.id}\n    ${found.integration.summary}`);
    process.exit(1);
  }

  const found = await findIntegration(INTEGRATIONS_DIR, id);
  await runIntegration({ found, providers, dryRun });
}

main().catch((err) => {
  if (err instanceof FerryError) {
    logError(err.message);
    for (const detail of err.details) console.error(`  ${detail}`);
    process.exit(1);
  }
  if (isAwsError(err)) logError(describeAwsError(err));
  if (err instanceof GithubApiError) logError(describeGithubError(err));
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
