import type { StepContext } from "../../../../src/core/define";
import { awsClients, describeResourceTags } from "../../../../src/providers/aws";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { ec2 } = awsClients(ctx);
  const instanceId = ctx.params.INSTANCE_ID;
  const desired = ctx.params.TAGS;

  const actual = await describeResourceTags(ec2, instanceId);

  for (const [key, value] of Object.entries(desired)) {
    if (actual[key] !== value) {
      throw new Error(
        `Expected ${instanceId} tag "${key}" to be "${value}", found "${actual[key] ?? "(missing)"}"`,
      );
    }
  }

  if (!ctx.params.PRUNE_UNMANAGED_TAGS) {
    // Pruning is off — confirm the desired set is a subset (pre-existing,
    // untouched tags must still be present, not accidentally dropped).
    const missing = Object.keys(desired).filter((key) => !(key in actual));
    if (missing.length > 0) {
      throw new Error(`Expected ${instanceId} to still have tag(s): ${missing.join(", ")}`);
    }
  } else {
    const unexpected = Object.keys(actual).filter((key) => !(key in desired));
    if (unexpected.length > 0) {
      throw new Error(
        `Expected ${instanceId} to have only the desired tag set with PRUNE_UNMANAGED_TAGS=true, found unmanaged: ${unexpected.join(", ")}`,
      );
    }
  }

  ctx.log.success(`Confirmed ${Object.keys(desired).length} tag(s) match the desired set on ${instanceId}`);
}
