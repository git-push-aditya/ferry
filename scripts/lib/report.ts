import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
