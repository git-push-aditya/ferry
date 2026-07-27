import { describe, expect, test } from "bun:test";
import { decodePrivateKey } from "../../scripts/lib/snowflake";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIExampleKeyBody==\n-----END PRIVATE KEY-----\n";

describe("decodePrivateKey", () => {
  test("passes a raw PEM string through unchanged", () => {
    expect(decodePrivateKey(PEM)).toBe(PEM.trim());
  });

  test("base64-decodes a value that isn't already PEM text", () => {
    const encoded = Buffer.from(PEM).toString("base64");
    expect(decodePrivateKey(encoded)).toBe(PEM);
  });
});
