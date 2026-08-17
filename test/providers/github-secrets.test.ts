import { describe, expect, test } from "bun:test";
import sodium from "libsodium-wrappers";
import {
  fetchPublicKey,
  getOrgSecretVisibility,
  putSecret,
  sealedBoxEncrypt,
  secretExists,
  setOrgSecretSelectedRepositories,
} from "../../src/providers/github/secrets";
import { fakeGithubClient, type Call } from "../helpers/github-fake-client";

describe("sealedBoxEncrypt", () => {
  test("round-trips through libsodium's own crypto_box_seal_open — matches GitHub's documented encryption scheme exactly", async () => {
    await sodium.ready;
    const keyPair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);

    const ciphertextBase64 = await sealedBoxEncrypt(publicKeyBase64, "super-secret-value");

    const ciphertext = sodium.from_base64(ciphertextBase64, sodium.base64_variants.ORIGINAL);
    const decrypted = sodium.crypto_box_seal_open(ciphertext, keyPair.publicKey, keyPair.privateKey);
    expect(sodium.to_string(decrypted)).toBe("super-secret-value");
  });

  test("encrypting the same plaintext twice produces different ciphertext (randomized sealed-box)", async () => {
    await sodium.ready;
    const keyPair = sodium.crypto_box_keypair();
    const publicKeyBase64 = sodium.to_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);

    const a = await sealedBoxEncrypt(publicKeyBase64, "value");
    const b = await sealedBoxEncrypt(publicKeyBase64, "value");
    expect(a).not.toBe(b);
  });
});

describe("fetchPublicKey / secretExists", () => {
  test("fetchPublicKey reads key_id + key from the scoped public-key endpoint", async () => {
    const calls: Call[] = [];
    const client = fakeGithubClient((method, path) => {
      expect(method).toBe("GET");
      expect(path).toBe("/repos/o/r/actions/secrets/public-key");
      return { status: 200, data: { key_id: "key-1", key: "base64key" } };
    }, calls);

    const key = await fetchPublicKey(client, { kind: "repo", owner: "o", repo: "r" });
    expect(key).toEqual({ keyId: "key-1", key: "base64key" });
  });

  test("secretExists: 200 -> true, 404 -> false", async () => {
    const trueClient = fakeGithubClient(() => ({ status: 200, data: {} }));
    expect(await secretExists(trueClient, { kind: "org", org: "acme" }, "S")).toBe(true);

    const falseClient = fakeGithubClient(() => ({ status: 404, data: {} }));
    expect(await secretExists(falseClient, { kind: "org", org: "acme" }, "S")).toBe(false);
  });
});

describe("putSecret", () => {
  test("repo scope: body has no visibility fields", async () => {
    const calls: Call[] = [];
    const client = fakeGithubClient(() => ({ status: 201, data: {} }), calls);
    const result = await putSecret(client, { kind: "repo", owner: "o", repo: "r" }, "S", "enc", "key-1");
    expect(result.created).toBe(true);
    expect(calls[0]!.body).toEqual({ encrypted_value: "enc", key_id: "key-1" });
  });

  test("org scope with visibility=selected includes selected_repository_ids in the same PUT", async () => {
    const calls: Call[] = [];
    const client = fakeGithubClient(() => ({ status: 204, data: {} }), calls);
    const result = await putSecret(client, { kind: "org", org: "acme" }, "S", "enc", "key-1", {
      visibility: "selected",
      selectedRepositoryIds: [1, 2],
    });
    expect(result.created).toBe(false);
    expect(calls[0]!.body).toEqual({
      encrypted_value: "enc",
      key_id: "key-1",
      visibility: "selected",
      selected_repository_ids: [1, 2],
    });
  });

  test("org scope with visibility=all omits selected_repository_ids", async () => {
    const calls: Call[] = [];
    const client = fakeGithubClient(() => ({ status: 201, data: {} }), calls);
    await putSecret(client, { kind: "org", org: "acme" }, "S", "enc", "key-1", { visibility: "all" });
    expect(calls[0]!.body).toEqual({ encrypted_value: "enc", key_id: "key-1", visibility: "all" });
  });
});

describe("getOrgSecretVisibility", () => {
  test("visibility=private: does not fetch the selected-repositories list", async () => {
    const calls: Call[] = [];
    const client = fakeGithubClient(() => ({ status: 200, data: { visibility: "private" } }), calls);
    const result = await getOrgSecretVisibility(client, "acme", "S");
    expect(result).toEqual({ visibility: "private" });
    expect(calls).toHaveLength(1);
  });

  test("visibility=selected: fetches and returns the selected repository ids", async () => {
    const client = fakeGithubClient((method, path) => {
      if (path.endsWith("/repositories")) return { status: 200, data: { repositories: [{ id: 1 }, { id: 2 }] } };
      return { status: 200, data: { visibility: "selected" } };
    });
    const result = await getOrgSecretVisibility(client, "acme", "S");
    expect(result).toEqual({ visibility: "selected", selectedRepositoryIds: [1, 2] });
  });

  test("404 -> undefined", async () => {
    const client = fakeGithubClient(() => ({ status: 404, data: {} }));
    expect(await getOrgSecretVisibility(client, "acme", "S")).toBeUndefined();
  });
});

describe("setOrgSecretSelectedRepositories", () => {
  test("replaces the selected-repo list without touching the value", async () => {
    const calls: Call[] = [];
    const client = fakeGithubClient(() => ({ status: 204, data: {} }), calls);
    await setOrgSecretSelectedRepositories(client, "acme", "S", [5, 6]);
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/orgs/acme/actions/secrets/S/repositories",
      body: { selected_repository_ids: [5, 6] },
    });
  });
});
