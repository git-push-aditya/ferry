import { descUser } from "../../../../src/providers/snowflake";
import type { SnowflakeConnection } from "../../../../src/providers/snowflake";

/**
 * Snowflake gives each user exactly two RSA public-key property slots —
 * `RSA_PUBLIC_KEY` and `RSA_PUBLIC_KEY_2` — which is what makes a genuinely
 * zero-downtime key rotation possible: set the new key into the unused slot,
 * let clients cut over, then clear the old slot. This is shared by
 * `rotate-user-key-pair` (which owns the two-phase mint/cutover state machine)
 * and `add-public-key-to-existing-user` (which just needs to find an empty
 * slot to attach an additional key into).
 */
export type KeySlot = "1" | "2";

export interface KeySlotOccupancy {
  slot1Occupied: boolean;
  slot2Occupied: boolean;
}

const FP_PROPERTY: Record<KeySlot, string> = {
  "1": "RSA_PUBLIC_KEY_FP",
  "2": "RSA_PUBLIC_KEY_2_FP",
};

/**
 * `DESC USER` does not echo the raw key material back — only its fingerprint
 * property (`RSA_PUBLIC_KEY_FP` / `RSA_PUBLIC_KEY_2_FP`). A slot is occupied
 * whenever its fingerprint is present and non-empty; Snowflake reports an
 * unset property as an empty string (never the literal string "null").
 */
function isOccupied(props: Map<string, string>, slot: KeySlot): boolean {
  const value = props.get(FP_PROPERTY[slot]);
  return !!value && value.trim().length > 0;
}

/** Reads `DESC USER` once and reports which of the two key slots hold a key. */
export async function keySlotOccupancy(
  conn: SnowflakeConnection,
  userName: string,
): Promise<KeySlotOccupancy> {
  const props = await descUser(conn, userName);
  return {
    slot1Occupied: isOccupied(props, "1"),
    slot2Occupied: isOccupied(props, "2"),
  };
}

/** Re-reads a single slot's fingerprint occupancy from a fresh `DESC USER`. */
export async function isSlotOccupied(
  conn: SnowflakeConnection,
  userName: string,
  slot: KeySlot,
): Promise<boolean> {
  const props = await descUser(conn, userName);
  return isOccupied(props, slot);
}

/** The `ALTER USER ... SET <property>` name for a given slot. */
export function slotProperty(slot: KeySlot): string {
  return slot === "2" ? "RSA_PUBLIC_KEY_2" : "RSA_PUBLIC_KEY";
}

/**
 * `PUBLIC_KEY` params may arrive as a full PEM block or bare base64.
 * Snowflake's `RSA_PUBLIC_KEY`/`RSA_PUBLIC_KEY_2` properties want just the
 * base64 body — no armor, no line breaks.
 */
export function cleanPublicKey(raw: string): string {
  return raw
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
}
