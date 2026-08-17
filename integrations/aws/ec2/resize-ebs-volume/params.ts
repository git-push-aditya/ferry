import { z } from "zod";
import { nonEmpty } from "../../../../src/core/env";

/**
 * Positive-integer GiB. AWS accepts only whole-GiB volume sizes, and this
 * integration only ever grows a volume — never shrinks it — so the shrink
 * case is rejected here as a params-validation error, not surfaced as a
 * runtime "conflict" from check().
 */
const positiveGib = z.coerce
  .number()
  .int("must be a whole number of GiB")
  .positive("must be a positive number of GiB");

export const paramsSchema = z
  .object({
    VOLUME_ID: nonEmpty,
    TARGET_SIZE_GIB: positiveGib,

    // Optional, and only passed through to ModifyVolume if explicitly set —
    // this integration is about size growth, not about changing volume type
    // or performance characteristics as a side effect.
    VOLUME_TYPE: z.string().optional(),
    IOPS: z.coerce.number().int().positive().optional(),
    THROUGHPUT: z.coerce.number().int().positive().optional(),

    // Optional SSM sub-step — both-or-neither. Leaving these unset means
    // create() stops at the AWS-side resize and never touches the guest OS.
    SSM_DOCUMENT_NAME: z.string().optional(),
    SSM_INSTANCE_ID: z.string().optional(),
  })
  .superRefine((p, ctx) => {
    const hasDoc = Boolean(p.SSM_DOCUMENT_NAME);
    const hasInstance = Boolean(p.SSM_INSTANCE_ID);
    if (hasDoc !== hasInstance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasDoc ? ["SSM_INSTANCE_ID"] : ["SSM_DOCUMENT_NAME"],
        message:
          "SSM_DOCUMENT_NAME and SSM_INSTANCE_ID must both be set to opt into the in-OS grow sub-step, or both left empty to skip it",
      });
    }
  });

export type Params = z.infer<typeof paramsSchema>;
