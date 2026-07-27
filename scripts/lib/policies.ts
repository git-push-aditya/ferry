// Builders that emit the CANONICAL TESTED ARTIFACTS verbatim (see project prompt).
// Do NOT add, remove, or broaden any action, resource, principal, or condition here.
// The only variation permitted is the parameter substitutions below.

export function integrationRolePolicy(bucket: string, prefix: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BucketPermissions",
        Effect: "Allow",
        Action: ["s3:GetBucketLocation", "s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "ObjectPermissions",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: `arn:aws:s3:::${bucket}/${prefix}*`,
      },
    ],
  };
}

export function initialRoleTrustPolicy(accountId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: `arn:aws:iam::${accountId}:root` },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

export function finalRoleTrustPolicy(storageAwsIamUserArn: string, storageAwsExternalId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { AWS: storageAwsIamUserArn },
        Action: "sts:AssumeRole",
        Condition: {
          StringEquals: { "sts:ExternalId": storageAwsExternalId },
        },
      },
    ],
  };
}

export function backendUserPolicy(bucket: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "BucketAccess",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: "ObjectAccess",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  };
}
