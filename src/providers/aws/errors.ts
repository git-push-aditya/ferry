interface AwsErrorLike {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

/** True for errors that actually came from the AWS SDK (which always attaches $metadata). */
export function isAwsError(err: unknown): boolean {
  return Boolean((err as AwsErrorLike)?.$metadata);
}

export function describeAwsError(err: unknown): string {
  const e = err as AwsErrorLike;
  switch (e?.name) {
    case "AccessDenied":
      return "AWS denied this call — the bootstrap credentials lack a required IAM permission.";
    case "BucketAlreadyExists":
      return "That S3 bucket name is taken globally — pick a different EXPORT_S3_BUCKET.";
    case "NoSuchEntityException":
      return "Referenced IAM entity does not exist.";
    default:
      return `${e?.name ?? "Unknown AWS error"} (HTTP ${e?.$metadata?.httpStatusCode ?? "?"})`;
  }
}

export function isAssumeRoleDenied(err: unknown): boolean {
  const e = err as AwsErrorLike;
  const msg = `${e?.name ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return (
    msg.includes("accessdenied") ||
    msg.includes("access denied") ||
    msg.includes("assume") ||
    msg.includes("not authorized")
  );
}

/**
 * A freshly created IAM access key is not usable immediately: for a few seconds
 * S3/STS may reject it as unknown or mis-signed. Those two names mean "not
 * propagated yet", not "the policy is wrong", so they are worth retrying —
 * unlike a genuine AccessDenied, which means the policy really doesn't allow it.
 */
export function isCredentialNotYetActive(err: unknown): boolean {
  const name = (err as AwsErrorLike)?.name ?? "";
  return name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch";
}
