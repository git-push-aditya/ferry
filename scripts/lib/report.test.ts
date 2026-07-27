import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeReport } from "./report";

let workDir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  workDir = await mkdtemp(path.join(tmpdir(), "report-test-"));
  process.chdir(workDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
});

describe("writeReport", () => {
  test("creates ./output if it doesn't exist and writes the markdown into it", async () => {
    const filePath = await writeReport("s3_export_int_zap_staging", "# hello\n");

    expect(filePath.startsWith(path.join(workDir, "output"))).toBe(true);
    expect(await readFile(filePath, "utf8")).toBe("# hello\n");
  });

  test("names the file <name>-<YYYY-MM-DD>.md", async () => {
    const filePath = await writeReport("my-integration", "content");
    const datePattern = /^my-integration-\d{4}-\d{2}-\d{2}\.md$/;

    expect(datePattern.test(path.basename(filePath))).toBe(true);
  });

  test("sanitizes characters that aren't safe in a filename", async () => {
    const filePath = await writeReport("weird name/with:chars", "content");

    expect(path.basename(filePath)).not.toMatch(/[/\\:]/);
  });

  test("chmods the file to 0600 since it may contain credentials", async () => {
    const filePath = await writeReport("perm-check", "secret");
    const mode = (await stat(filePath)).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  test("is safe to call twice — output/ already existing is not an error", async () => {
    await writeReport("first", "one");
    await expect(writeReport("second", "two")).resolves.toBeString();
  });
});
