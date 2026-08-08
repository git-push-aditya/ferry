/**
 * A single misconfiguration the engine can explain in full, rather than an SDK
 * stack trace. Thrown by the plan phase (conflicts, illegal env layering) and by
 * steps that detect a state the user has to resolve by hand.
 *
 * Provider-specific error vocabulary does NOT live here — see
 * `src/providers/aws/errors.ts`. Core stays free of anything that knows what an
 * S3 bucket or a Snowflake integration is.
 */
export class FerryError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = "FerryError";
    this.details = details;
  }
}
