import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { offboardStep } from "../../integrations/snowflake/offboard-developer/steps/offboard";
import type { Params as OffboardParams } from "../../integrations/snowflake/offboard-developer/params";
import { grantAccessStep } from "../../integrations/snowflake/grant-database-schema-access/steps/grant-access";
import type { Params as GrantParams } from "../../integrations/snowflake/grant-database-schema-access/params";
import { auditStep } from "../../integrations/snowflake/audit-user-access/steps/audit";
import type { AuditReport } from "../../integrations/snowflake/audit-user-access/steps/audit";
import type { Params as AuditParams } from "../../integrations/snowflake/audit-user-access/params";
import { iamPolicyStep } from "../../integrations/snowflake/create-storage-s3-integration/steps/iam-policy";
import type { Params as StorageParams } from "../../integrations/snowflake/create-storage-s3-integration/params";
import { integrationRolePolicy } from "../../integrations/snowflake/create-storage-s3-integration/policies";

import { TEST_AWS_ACCOUNT } from "../helpers/test-aws-account";
const ACCOUNT = TEST_AWS_ACCOUNT;
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

function sfCtx<P>(
  params: P,
  outputs: Record<string, unknown>,
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>,
): StepContext<P> {
  const conn = { connection: {}, runQuery, close: async () => {} };
  return {
    params,
    creds: {},
    clients: { snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

function iamCtx<P>(
  params: P,
  outputs: Record<string, unknown>,
  send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
): StepContext<P> {
  const iam = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params,
    creds: {},
    clients: { aws: { s3: iam, iam, sts: iam, region: "ap-south-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

const OFFBOARD_PARAMS_DISABLE: OffboardParams = { USER_NAME: "JDOE", HARD_DELETE: false };
const OFFBOARD_PARAMS_HARD: OffboardParams = { USER_NAME: "JDOE", HARD_DELETE: true };

describe("offboard-developer", () => {
  test("check(): user still present -> missing (needs offboarding)", async () => {
    const ctx = sfCtx(OFFBOARD_PARAMS_DISABLE, {}, async () => [{ name: "JDOE" }]);
    expect(await offboardStep.check(ctx)).toBe("missing");
  });

  test("check(): user already gone -> exists (clean, no-op)", async () => {
    const ctx = sfCtx(OFFBOARD_PARAMS_DISABLE, {}, async () => []);
    expect(await offboardStep.check(ctx)).toBe("exists");
  });

  test("create(): default DISABLED=TRUE path revokes all captured roles, then disables", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(OFFBOARD_PARAMS_DISABLE, {}, async (sql) => {
      queries.push(sql);
      if (sql.startsWith("SHOW GRANTS TO USER")) return [{ role: "ANALYST" }, { role: "READER" }];
      return [];
    });

    const outputs = await offboardStep.create!(ctx);

    expect(queries).toEqual([
      "SHOW GRANTS TO USER JDOE;",
      "REVOKE ROLE ANALYST FROM USER JDOE;",
      "REVOKE ROLE READER FROM USER JDOE;",
      "ALTER USER JDOE SET DISABLED = TRUE;",
    ]);
    expect(outputs.hardDeleted).toBe(false);
    expect(JSON.parse(String(outputs.revokedRoles))).toEqual(["ANALYST", "READER"]);
  });

  test("create(): opt-in HARD_DELETE=true path drops the user instead of disabling", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(OFFBOARD_PARAMS_HARD, {}, async (sql) => {
      queries.push(sql);
      if (sql.startsWith("SHOW GRANTS TO USER")) return [{ role: "ANALYST" }];
      return [];
    });

    const outputs = await offboardStep.create!(ctx);

    expect(queries).toEqual([
      "SHOW GRANTS TO USER JDOE;",
      "REVOKE ROLE ANALYST FROM USER JDOE;",
      "DROP USER JDOE;",
    ]);
    expect(outputs.hardDeleted).toBe(true);
  });

  test("rollback(): disable path re-enables and re-grants every captured role", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(
      OFFBOARD_PARAMS_DISABLE,
      { hardDeleted: false, revokedRoles: JSON.stringify(["ANALYST", "READER"]) },
      async (sql) => {
        queries.push(sql);
        return [];
      },
    );

    await offboardStep.rollback(ctx);

    expect(queries).toEqual([
      "ALTER USER JDOE SET DISABLED = FALSE;",
      "GRANT ROLE ANALYST TO USER JDOE;",
      "GRANT ROLE READER TO USER JDOE;",
    ]);
  });

  test("rollback(): hard-delete path only warns and makes no calls", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(OFFBOARD_PARAMS_HARD, { hardDeleted: true }, async (sql) => {
      queries.push(sql);
      return [];
    });

    await offboardStep.rollback(ctx);

    expect(queries).toEqual([]);
  });
});

const GRANT_PARAMS: GrantParams = {
  ROLE_NAME: "ANALYST",
  OBJECT_TYPE: "SCHEMA",
  OBJECT_NAME: "DB.SCHEMA",
  DESIRED_PRIVILEGES: ["USAGE", "SELECT"],
  PRUNE_UNMANAGED_PRIVILEGES: false,
};

describe("grant-database-schema-access", () => {
  test("check() always reconciles", async () => {
    const ctx = sfCtx(GRANT_PARAMS, {}, async () => []);
    expect(await grantAccessStep.check(ctx)).toBe("missing");
  });

  test("reconcile(): grants missing privileges, leaves extras alone when PRUNE is false", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(GRANT_PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [{ grantee_name: "ANALYST", privilege: "USAGE" }, { grantee_name: "ANALYST", privilege: "MODIFY" }];
    });

    const outputs = await grantAccessStep.reconcile!(ctx);

    expect(queries[1]).toBe("GRANT SELECT ON SCHEMA DB.SCHEMA TO ROLE ANALYST;");
    expect(queries.some((q) => q.startsWith("REVOKE"))).toBe(false);
    expect(JSON.parse(String(outputs.executedGrants))).toEqual(["SELECT"]);
    expect(JSON.parse(String(outputs.executedRevokes))).toEqual([]);
  });

  test("reconcile(): with PRUNE_UNMANAGED_PRIVILEGES=true, revokes extras too", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(
      { ...GRANT_PARAMS, PRUNE_UNMANAGED_PRIVILEGES: true },
      {},
      async (sql) => {
        queries.push(sql);
        return [{ grantee_name: "ANALYST", privilege: "USAGE" }, { grantee_name: "ANALYST", privilege: "MODIFY" }];
      },
    );

    const outputs = await grantAccessStep.reconcile!(ctx);

    expect(queries).toContain("GRANT SELECT ON SCHEMA DB.SCHEMA TO ROLE ANALYST;");
    expect(queries).toContain("REVOKE MODIFY ON SCHEMA DB.SCHEMA FROM ROLE ANALYST;");
    expect(JSON.parse(String(outputs.executedRevokes))).toEqual(["MODIFY"]);
  });

  test("reconcile(): already exactly desired -> no SQL beyond the read", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(GRANT_PARAMS, {}, async (sql) => {
      queries.push(sql);
      return [
        { grantee_name: "ANALYST", privilege: "USAGE" },
        { grantee_name: "ANALYST", privilege: "SELECT" },
      ];
    });

    await grantAccessStep.reconcile!(ctx);

    expect(queries).toHaveLength(1);
  });

  test("rollback(): reverses the EXECUTED grants/revokes, not the originally planned diff", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(
      GRANT_PARAMS,
      { executedGrants: JSON.stringify(["SELECT"]), executedRevokes: JSON.stringify(["MODIFY"]) },
      async (sql) => {
        queries.push(sql);
        return [];
      },
    );

    await grantAccessStep.rollback(ctx);

    expect(queries).toEqual([
      "REVOKE SELECT ON SCHEMA DB.SCHEMA FROM ROLE ANALYST;",
      "GRANT MODIFY ON SCHEMA DB.SCHEMA TO ROLE ANALYST;",
    ]);
  });
});

const AUDIT_PARAMS: AuditParams = { USER_NAME: "JDOE" };
const MUTATING_SQL = /^\s*(CREATE|ALTER|DROP|COPY|GRANT|REVOKE)/i;

describe("audit-user-access", () => {
  test("check() always reconciles (routes to create for a fresh read every run)", async () => {
    const ctx = sfCtx(AUDIT_PARAMS, {}, async () => []);
    expect(await auditStep.check(ctx)).toBe("missing");
  });

  test("create(): never issues a mutating statement, only SHOW/DESC reads", async () => {
    const queries: string[] = [];
    const ctx = sfCtx(AUDIT_PARAMS, {}, async (sql) => {
      queries.push(sql);
      if (sql.startsWith("SHOW USERS")) return [{ name: "JDOE" }];
      if (sql.startsWith("SHOW GRANTS TO USER")) return [{ role: "ANALYST" }];
      if (sql.startsWith("DESC USER")) {
        return [
          { property: "DISABLED", value: "false" },
          { property: "DEFAULT_ROLE", value: "ANALYST" },
          { property: "RSA_PUBLIC_KEY_FP", value: "" },
        ];
      }
      if (sql.startsWith("SHOW GRANTS TO ROLE")) {
        return [{ privilege: "USAGE", granted_on: "DATABASE", name: "DB" }];
      }
      if (sql.startsWith("SHOW GRANTS OF ROLE")) return [];
      return [];
    });

    const outputs = await auditStep.create!(ctx);

    expect(queries.every((q) => !MUTATING_SQL.test(q))).toBe(true);
    const report = JSON.parse(String(outputs.auditReport)) as AuditReport;
    expect(report.userName).toBe("JDOE");
    expect(report.disabled).toBe("false");
    expect(report.defaultRole).toBe("ANALYST");
    expect(report.hasRsaKey).toBe(false);
    expect(report.roles).toEqual([
      { roleName: "ANALYST", privileges: [{ privilege: "USAGE", grantedOn: "DATABASE", name: "DB" }], grantedToRoles: [] },
    ]);
  });

  test("create(): output report data is well-formed JSON", async () => {
    const ctx = sfCtx(AUDIT_PARAMS, {}, async (sql) => {
      if (sql.startsWith("SHOW USERS")) return [{ name: "JDOE" }];
      return [];
    });

    const outputs = await auditStep.create!(ctx);

    expect(() => JSON.parse(String(outputs.auditReport))).not.toThrow();
  });

  test("create(): throws a clear error if the target user doesn't exist", async () => {
    const ctx = sfCtx(AUDIT_PARAMS, {}, async () => []);

    await expect(auditStep.create!(ctx)).rejects.toThrow(/no such Snowflake user/);
  });

  test("rollback() is a no-op: nothing was ever mutated", async () => {
    await expect(auditStep.rollback(sfCtx(AUDIT_PARAMS, {}, async () => []))).resolves.toBeUndefined();
  });
});

describe("create-storage-s3-integration — ACCESS_MODE extension", () => {
  const STORAGE_PARAMS_RW: StorageParams = {
    EXPORT_S3_BUCKET: "ferry-bucket",
    EXPORT_S3_PREFIX: "snowflake/",
    SF_STORAGE_INTEGRATION_NAME: "ferry_int",
    SF_STAGE_NAME: "ferry_stage",
    AWS_STORAGE_ROLE_NAME: "ferry-role",
    AWS_STORAGE_POLICY_NAME: "ferry-policy",
    ACCESS_MODE: "read-write",
  };
  const STORAGE_PARAMS_RO: StorageParams = { ...STORAGE_PARAMS_RW, ACCESS_MODE: "read-only" };

  test("read-write mode produces the same IAM policy actions as before (regression)", () => {
    const policy = integrationRolePolicy("ferry-bucket", "snowflake/", "read-write");
    const objectStatement = policy.Statement.find((s) => s.Sid === "ObjectPermissions")!;

    expect(objectStatement.Action).toEqual(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
    expect(objectStatement.Action).toContain("s3:PutObject");
    expect(objectStatement.Action).toContain("s3:DeleteObject");
    expect(objectStatement.Action).toContain("s3:GetObject");
    const bucketStatement = policy.Statement.find((s) => s.Sid === "BucketPermissions")!;
    expect(bucketStatement.Action).toContain("s3:ListBucket");
  });

  test("read-only mode excludes PutObject/DeleteObject while keeping GetObject/ListBucket", () => {
    const policy = integrationRolePolicy("ferry-bucket", "snowflake/", "read-only");
    const objectStatement = policy.Statement.find((s) => s.Sid === "ObjectPermissions")!;

    expect(objectStatement.Action).not.toContain("s3:PutObject");
    expect(objectStatement.Action).not.toContain("s3:DeleteObject");
    expect(objectStatement.Action).toContain("s3:GetObject");
    const bucketStatement = policy.Statement.find((s) => s.Sid === "BucketPermissions")!;
    expect(bucketStatement.Action).toContain("s3:ListBucket");
  });

  test("iam-policy step's create() passes ACCESS_MODE through to the policy document (read-write)", async () => {
    let sentDocument = "";
    const ctx = iamCtx(STORAGE_PARAMS_RW, {}, (command) => {
      sentDocument = String(command.input.PolicyDocument);
      return {};
    });

    await iamPolicyStep.create!(ctx);

    const parsed = JSON.parse(sentDocument);
    const objectStatement = parsed.Statement.find((s: { Sid: string }) => s.Sid === "ObjectPermissions");
    expect(objectStatement.Action).toEqual(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
  });

  test("iam-policy step's create() passes ACCESS_MODE through to the policy document (read-only)", async () => {
    let sentDocument = "";
    const ctx = iamCtx(STORAGE_PARAMS_RO, {}, (command) => {
      sentDocument = String(command.input.PolicyDocument);
      return {};
    });

    await iamPolicyStep.create!(ctx);

    const parsed = JSON.parse(sentDocument);
    const objectStatement = parsed.Statement.find((s: { Sid: string }) => s.Sid === "ObjectPermissions");
    expect(objectStatement.Action).toEqual(["s3:GetObject", "s3:ListBucket"]);
  });
});
