import { describe, expect, test } from "bun:test";
import { spokeTrustPolicy } from "../../integrations/github/github-oidc-spoke-role/params";

describe("github-oidc-spoke-role: spokeTrustPolicy", () => {
  test("trusts the hub role ARN via ordinary AssumeRole, no Condition block", () => {
    const doc = spokeTrustPolicy("arn:aws:iam::111111111111:role/hub-ci-role") as {
      Statement: { Effect: string; Principal: object; Action: string; Condition?: object }[];
    };
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0]!.Principal).toEqual({ AWS: "arn:aws:iam::111111111111:role/hub-ci-role" });
    expect(doc.Statement[0]!.Action).toBe("sts:AssumeRole");
    expect(doc.Statement[0]!.Condition).toBeUndefined();
  });
});
