import { describe, expect, test } from "bun:test";
import { describeAwsError, isAssumeRoleDenied } from "../../scripts/lib/errors";

describe("describeAwsError", () => {
  test("maps AccessDenied to an actionable message", () => {
    expect(describeAwsError({ name: "AccessDenied" })).toContain("IAM permission");
  });

  test("maps BucketAlreadyExists to an actionable message", () => {
    expect(describeAwsError({ name: "BucketAlreadyExists" })).toContain("EXPORT_S3_BUCKET");
  });

  test("maps NoSuchEntityException to an actionable message", () => {
    expect(describeAwsError({ name: "NoSuchEntityException" })).toContain("does not exist");
  });

  test("falls back to name + http status for unrecognized errors", () => {
    const message = describeAwsError({ name: "Throttling", $metadata: { httpStatusCode: 429 } });
    expect(message).toBe("Throttling (HTTP 429)");
  });

  test("falls back to 'Unknown AWS error' when the error has no name at all", () => {
    expect(describeAwsError({})).toContain("Unknown AWS error");
  });

  test("still surfaces a plain Error's name and message rather than crashing", () => {
    expect(describeAwsError(new Error("boom"))).toBe("Error (HTTP ?)");
  });
});

describe("isAssumeRoleDenied", () => {
  test("recognizes an AccessDenied name", () => {
    expect(isAssumeRoleDenied({ name: "AccessDenied", message: "" })).toBe(true);
  });

  test("recognizes an assume-role message even without a matching name", () => {
    expect(
      isAssumeRoleDenied({ name: "SomeSnowflakeError", message: "unable to assume role for stage" }),
    ).toBe(true);
  });

  test("recognizes a 'not authorized' message", () => {
    expect(isAssumeRoleDenied({ message: "User is not authorized to perform sts:AssumeRole" })).toBe(true);
  });

  test("returns false for unrelated errors so they are not silently retried", () => {
    expect(isAssumeRoleDenied({ name: "SyntaxError", message: "unexpected token" })).toBe(false);
  });
});
