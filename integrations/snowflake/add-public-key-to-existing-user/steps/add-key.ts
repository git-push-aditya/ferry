import type { Step } from "../../../../src/core/define";
import { snowflakeClients, sqlLiteral, userState } from "../../../../src/providers/snowflake";
import {
  cleanPublicKey,
  keySlotOccupancy,
  slotProperty,
  type KeySlot,
} from "../../rotate-user-key-pair/steps/key-slots";
import type { Params } from "../params";

/**
 * Attaches an additional public key to an already-provisioned user — the
 * "use the second slot" half of the two-slot rotation mechanism, usable
 * standalone (e.g. for the lead to run with their elevated role).
 *
 * Slot selection: an explicit `TARGET_SLOT` param always wins. Left unset,
 * the empty slot is auto-detected — `RSA_PUBLIC_KEY` first (this may be the
 * very first key for the user), then `RSA_PUBLIC_KEY_2`. If both are already
 * occupied and the caller did not pin a slot, this is a `conflict`: silently
 * overwriting a key that might still be in active use is exactly the mistake
 * `rotate-user-key-pair` exists to do deliberately instead.
 */
export const addKeyStep: Step<Params> = {
  id: "add-public-key",
  title: "Add public key to existing user",

  async check(ctx) {
    const conn = await snowflakeClients(ctx).connection();

    if ((await userState(conn, ctx.params.USER_NAME)) !== "exists") {
      ctx.log.error(`User ${ctx.params.USER_NAME} does not exist — this task never creates a user`);
      return "conflict";
    }

    const { slot1Occupied, slot2Occupied } = await keySlotOccupancy(conn, ctx.params.USER_NAME);

    let slot: KeySlot;
    if (ctx.params.TARGET_SLOT) {
      slot = ctx.params.TARGET_SLOT;
    } else if (!slot1Occupied) {
      slot = "1";
    } else if (!slot2Occupied) {
      slot = "2";
    } else {
      ctx.log.error(
        `Both key slots on ${ctx.params.USER_NAME} are occupied. Set TARGET_SLOT="1"|"2" to ` +
          `explicitly overwrite one, or run rotate-user-key-pair for a proper zero-downtime rotation.`,
      );
      return "conflict";
    }

    ctx.outputs.targetKeySlot = slot;
    ctx.log.info(`Targeting slot ${slot} (${slotProperty(slot)})`);
    return "missing";
  },

  // The action slot: sets (or overwrites, if TARGET_SLOT was pinned onto an
  // occupied slot) the key property. Re-running with the same key against the
  // same slot is a no-op SET, so this is idempotent.
  async create(ctx) {
    const conn = await snowflakeClients(ctx).connection();
    const slot = ctx.outputs.targetKeySlot as KeySlot;
    const cleaned = cleanPublicKey(ctx.params.PUBLIC_KEY);

    await conn.runQuery(
      `ALTER USER ${ctx.params.USER_NAME} SET ${slotProperty(slot)} = ${sqlLiteral(cleaned)};`,
    );
    ctx.log.success(`Set ${slotProperty(slot)} on ${ctx.params.USER_NAME}`);

    return { targetKeySlot: slot, addedKeyThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.addedKeyThisRun !== true) return;
    const conn = await snowflakeClients(ctx).connection();
    const slot = ctx.outputs.targetKeySlot as KeySlot;
    await conn.runQuery(`ALTER USER ${ctx.params.USER_NAME} UNSET ${slotProperty(slot)};`);
  },

  resource(ctx) {
    const slot = ctx.outputs.targetKeySlot as KeySlot;
    return {
      type: "snowflake_user_public_key",
      name: `${ctx.params.USER_NAME}:slot${slot}`,
      attributes: { user: ctx.params.USER_NAME, slot },
    };
  },
};
