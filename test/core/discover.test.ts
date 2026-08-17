import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverIntegrations, findIntegration } from "../../src/core/discover";
import { FerryError } from "../../src/core/errors";

const REPO_INTEGRATIONS = path.join(import.meta.dir, "../../integrations");

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "ferry-discover-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes a throwaway integration folder, exactly as a contributor would. */
async function writeIntegration(relDir: string, id: string): Promise<void> {
  const dir = path.join(workDir, relDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "integration.ts"),
    `export default {
       id: ${JSON.stringify(id)},
       schemaVersion: 1,
       summary: "throwaway",
       params: { safeParse: () => ({ success: true, data: {} }) },
       credentials: [],
       steps: [],
       async verify() {},
       report: () => "",
     };
    `,
  );
}

describe("discoverIntegrations", () => {
  test("adding a folder is enough — no central list, import or switch to edit", async () => {
    await writeIntegration("acme/widget", "acme/widget");

    const found = await discoverIntegrations(workDir);

    expect(found.map((f) => f.id)).toEqual(["acme/widget"]);
    expect(found[0].integration.summary).toBe("throwaway");
  });

  test("derives the id from the folder path and reports the folder as the .env home", async () => {
    await writeIntegration("acme/widget", "acme/widget");

    const [found] = await discoverIntegrations(workDir);

    expect(found.dir).toBe(path.join(workDir, "acme", "widget"));
  });

  test("finds every integration, sorted, without being told how many there are", async () => {
    await writeIntegration("b/two", "b/two");
    await writeIntegration("a/one", "a/one");

    const found = await discoverIntegrations(workDir);

    expect(found.map((f) => f.id)).toEqual(["a/one", "b/two"]);
  });

  test("rejects a manifest whose id disagrees with its folder path", async () => {
    await writeIntegration("acme/widget", "acme/gadget");

    await expect(discoverIntegrations(workDir)).rejects.toThrow(FerryError);
  });

  test("an empty or missing integrations dir is not an error", async () => {
    expect(await discoverIntegrations(path.join(workDir, "nothing-here"))).toEqual([]);
  });
});

describe("findIntegration", () => {
  test("resolves this repo's real integrations by id", async () => {
    const found = await findIntegration(REPO_INTEGRATIONS, "snowflake/create-storage-s3-integration");
    expect(found.integration.credentials).toEqual(["aws", "snowflake"]);
  });

  test("the backend integration declares AWS credentials only", async () => {
    const found = await findIntegration(REPO_INTEGRATIONS, "aws/s3/create-backend-s3-user");
    expect(found.integration.credentials).toEqual(["aws"]);
  });

  test("lists what is available when the id is unknown", async () => {
    try {
      await findIntegration(REPO_INTEGRATIONS, "aws/does-not-exist");
      throw new Error("expected findIntegration to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(FerryError);
      expect((err as FerryError).details.join("\n")).toContain("snowflake/create-storage-s3-integration");
    }
  });
});
