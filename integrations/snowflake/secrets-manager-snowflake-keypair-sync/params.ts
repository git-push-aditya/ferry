import { z } from "zod";
import { nonEmpty } from "../../../src/core/env";

/** Folder .env values are always strings — same shape as delete-role's boolFlag. */
const boolFlag = (defaultValue: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(defaultValue)
    .transform((v) => v === "true");

export const paramsSchema = z.object({
  // Must already exist — this integration never creates a Snowflake user.
  SF_USER_NAME: nonEmpty,

  // Created if missing, updated (a new version) if it already exists.
  AWS_SECRET_NAME: nonEmpty,

  FORCE_ROTATE: boolFlag("false"),
});

export type Params = z.infer<typeof paramsSchema>;

export const SYNCED_FINGERPRINT_TAG_KEY = "ferry:synced-pubkey-fp";

/**
 * `RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2` want just the base64 body — no PEM
 * armor, no line breaks. Same transform as rotate-user-key-pair's
 * cleanPublicKey, duplicated here rather than imported: this is that
 * helper's second occurrence, still under this project's "two bespoke
 * copies fine" allowance.
 */
export function cleanPublicKey(pem: string): string {
  return pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
}
