import type { StepContext } from "../../../src/core/define";
import { requireOutput } from "../../../src/core/define";
import { descUser, snowflakeClients } from "../../../src/providers/snowflake";
import type { KeySlot } from "../rotate-user-key-pair/steps/key-slots";
import type { Params } from "./params";

const FP_PROPERTY: Record<KeySlot, string> = {
  "1": "RSA_PUBLIC_KEY_FP",
  "2": "RSA_PUBLIC_KEY_2_FP",
};

/** Live functional proof: the targeted slot's fingerprint is now non-empty. */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const conn = await snowflakeClients(ctx).connection();
  const slot = requireOutput<KeySlot>(ctx, "targetKeySlot");

  const props = await descUser(conn, ctx.params.USER_NAME);
  const fingerprint = props.get(FP_PROPERTY[slot]) ?? "";
  if (!fingerprint.trim()) {
    throw new Error(
      `${FP_PROPERTY[slot]} is still empty on ${ctx.params.USER_NAME} after setting slot ${slot}`,
    );
  }

  ctx.log.success(`Confirmed ${FP_PROPERTY[slot]} is populated on ${ctx.params.USER_NAME}`);
}
