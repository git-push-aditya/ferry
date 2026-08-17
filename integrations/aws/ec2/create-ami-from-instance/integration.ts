import type { z } from "zod";
import { defineIntegration } from "../../../../src/core/define";
import { paramsSchema, type Params } from "./params";
import { createAmiStep } from "./steps/create-ami";
import { verify } from "./verify";

/**
 * Bakes an AMI from an existing instance. Idempotent via a ferry identity
 * tag (integration id + caller-supplied LOGICAL_NAME) since there's no
 * natural "does this AMI already exist" check by name or content otherwise.
 */
export default defineIntegration<Params>({
  id: "aws/ec2/create-ami-from-instance",
  schemaVersion: 1,
  summary:
    "Creates an AMI from an EC2 instance, tagged for idempotent re-runs, with NO_REBOOT surfaced as a configurable consistency tradeoff.",

  // NO_REBOOT and TAGS_JSON both go through a ZodEffects transform (string
  // input, boolean/object output) — the same ZodType<P> cast precedent as
  // aws/s3/create-bucket.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws"],

  steps: [createAmiStep],

  verify,

  reportName: (ctx) => ctx.params.AMI_NAME,

  report(ctx) {
    const p = ctx.params;
    return `# AMI from Instance — \`${p.AMI_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry aws/ec2/create-ami-from-instance\`.

## AMI

- Name: \`${p.AMI_NAME}\`
- Image id: \`${ctx.outputs.imageId ?? "(unknown)"}\`
- Source instance: \`${p.INSTANCE_ID}\`
- Backing snapshots: \`${((ctx.outputs.snapshotIds as string[] | undefined) ?? []).join(", ") || "(none)"}\`

## NO_REBOOT

\`NO_REBOOT=${p.NO_REBOOT}\`. ${
      p.NO_REBOOT
        ? "The instance was NOT rebooted — snapshots only capture data already written to the volumes at creation time (crash-consistent, not fully consistent)."
        : "The instance WAS rebooted (AWS's default) to flush buffered data and data in memory to the volumes before the snapshots were taken, for full consistency."
    }

## Verification

Verified — confirmed the AMI is \`available\` and its block device mappings
reference the backing snapshots captured at creation time.

## Rollback

If this run's own creation needs to be undone, rollback deregisters the AMI
and deletes every backing snapshot captured above (deregistering alone does
not delete snapshots).
`;
  },
});
