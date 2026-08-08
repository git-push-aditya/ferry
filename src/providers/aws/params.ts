import { nonEmpty } from "../../core/env";

/**
 * A bare bucket name. `s3://…` and a trailing slash both parse fine as strings
 * but produce ARNs that silently match nothing, so they're rejected up front.
 */
export const s3BucketName = nonEmpty.refine(
  (v) => !v.startsWith("s3://") && !v.endsWith("/"),
  "must be a bare bucket name — no s3:// prefix, no trailing slash",
);

/** A key prefix. Without the trailing slash it selects sibling keys too. */
export const s3Prefix = nonEmpty.refine((v) => v.endsWith("/"), "must end with '/'");
