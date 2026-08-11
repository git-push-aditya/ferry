import { describe, expect, test } from "bun:test";
import { backendUserPolicy } from "../../integrations/aws/create-backend-s3-user/policies";
import {
  finalRoleTrustPolicy,
  initialRoleTrustPolicy,
  integrationRolePolicy,
} from "../../integrations/snowflake/create-storage-s3-integration/policies";

describe("integrationRolePolicy (artifact A)", () => {
  test("matches the canonical tested policy verbatim, params substituted", () => {
    expect(integrationRolePolicy("jarvis-csv-sf-store", "snowflake/")).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BucketPermissions",
          Effect: "Allow",
          Action: ["s3:GetBucketLocation", "s3:ListBucket"],
          Resource: "arn:aws:s3:::jarvis-csv-sf-store",
        },
        {
          Sid: "ObjectPermissions",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: "arn:aws:s3:::jarvis-csv-sf-store/snowflake/*",
        },
      ],
    });
  });

  test("bucket ARN statement never carries a trailing /*", () => {
    const policy = integrationRolePolicy("bucket", "prefix/");
    expect(policy.Statement[0].Resource.endsWith("*")).toBe(false);
  });
});

describe("initialRoleTrustPolicy (artifact B)", () => {
  test("trusts the account root with no external-id condition", () => {
    expect(initialRoleTrustPolicy("909317186541")).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::909317186541:root" },
          Action: "sts:AssumeRole",
        },
      ],
    });
  });
});

describe("finalRoleTrustPolicy (artifact C)", () => {
  test("trusts Snowflake's IAM user gated by the external id", () => {
    expect(
      finalRoleTrustPolicy(
        "arn:aws:iam::123456789012:user/abcd-s-account",
        "SFCRole=1_abc123=",
      ),
    ).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: "arn:aws:iam::123456789012:user/abcd-s-account" },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: { "sts:ExternalId": "SFCRole=1_abc123=" },
          },
        },
      ],
    });
  });
});

describe("backendUserPolicy (artifact H)", () => {
  test("matches the canonical tested policy verbatim — ListBucket included, object access bucket-wide", () => {
    expect(backendUserPolicy("jarvis-csv-sf-store")).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "BucketAccess",
          Effect: "Allow",
          Action: ["s3:ListBucket"],
          Resource: "arn:aws:s3:::jarvis-csv-sf-store",
        },
        {
          Sid: "ObjectAccess",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: "arn:aws:s3:::jarvis-csv-sf-store/*",
        },
      ],
    });
  });

  test("object access is bucket-wide, NOT scoped to a prefix (per canonical artifact)", () => {
    const policy = backendUserPolicy("bucket");
    expect(policy.Statement[1].Resource).toBe("arn:aws:s3:::bucket/*");
  });
});
