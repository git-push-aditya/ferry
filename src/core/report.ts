import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Keeps only the last few characters so a report can identify a secret without
 * containing it. Reports are 0600 and gitignored, but a masked value is still
 * the right default — the only thing that should ever print in full is a
 * freshly minted key, once, to stdout.
 */
export function mask(value: string, visible = 4): string {
  if (!value) return "";
  const hidden = Math.max(value.length - visible, 0);
  return `${"*".repeat(hidden)}${value.slice(-visible)}`;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Writes a markdown report into ./output/<name>-<date>.md (chmod 0600) and returns its path. */
export async function writeReport(nameHint: string, markdown: string): Promise<string> {
  const dir = path.join(process.cwd(), "output");
  await mkdir(dir, { recursive: true });

  const datestamp = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, `${sanitize(nameHint)}-${datestamp}.md`);

  await writeFile(filePath, markdown, { mode: 0o600 });
  await chmod(filePath, 0o600);

  return filePath;
}
