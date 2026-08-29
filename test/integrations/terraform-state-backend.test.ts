import { describe, expect, test } from "bun:test";
import { inlinePolicyName, terraformBackendPolicyDocument } from "../../integrations/github/terraform-state-backend-for-actions/params";

describe("terraform-state-backend-for-actions: policy document", () => {
  test("normalizes the prefix with a trailing slash and scopes object actions to it", () => {
    const withoutSlash = terraformBackendPolicyDocument("my-bucket", "tf-state") as {
      Statement: { Sid: string; Resource: string }[];
    };
    const withSlash = terraformBackendPolicyDocument("my-bucket", "tf-state/") as {
      Statement: { Sid: string; Resource: string }[];
    };
    expect(withoutSlash).toEqual(withSlash);

    const objStmt = withoutSlash.Statement.find((s) => s.Sid === "TerraformStateObjects");
    expect(objStmt?.Resource).toBe("arn:aws:s3:::my-bucket/tf-state/*");
  });

  test("bucket-level statement is not scoped to the prefix", () => {
    const doc = terraformBackendPolicyDocument("my-bucket", "tf-state") as {
      Statement: { Sid: string; Resource: string }[];
    };
    const bucketStmt = doc.Statement.find((s) => s.Sid === "TerraformStateBucket");
    expect(bucketStmt?.Resource).toBe("arn:aws:s3:::my-bucket");
  });

  test("inline policy name is stable", () => {
    expect(inlinePolicyName()).toBe("ferry-terraform-state-backend");
  });
});
