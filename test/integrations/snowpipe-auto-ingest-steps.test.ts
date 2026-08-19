import { describe, expect, test } from "bun:test";
import type { StepContext } from "../../src/core/define";
import { pipeStep } from "../../integrations/snowflake/snowpipe-auto-ingest/steps/pipe";
import { bucketNotificationStep } from "../../integrations/snowflake/snowpipe-auto-ingest/steps/bucket-notification";
import { notificationEntryId } from "../../integrations/snowflake/snowpipe-auto-ingest/params";
import type { Params } from "../../integrations/snowflake/snowpipe-auto-ingest/params";

const ACCOUNT = "909317186541";
const NO_LOG = { info() {}, warn() {}, error() {}, success() {} };

const PARAMS: Params = {
  SF_PIPE_NAME: "ferry_pipe",
  SF_TARGET_TABLE: "raw.events",
  SF_STAGE_NAME: "ferry_stage",
  SF_FILE_FORMAT: "TYPE = CSV",
  S3_BUCKET_NAME: "ferry-bucket",
  S3_INGEST_PREFIX: "landing/",
};

function snowflakeCtx(
  outputs: Record<string, unknown>,
  runQuery: (sql: string) => Promise<Record<string, unknown>[]>,
): StepContext<Params> {
  const conn = { connection: {}, runQuery, close: async () => {} };
  return {
    params: PARAMS,
    creds: {},
    clients: { snowflake: { connection: async () => conn, peek: () => conn, close: async () => {} } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

function s3Ctx(
  outputs: Record<string, unknown>,
  send: (command: FakeCommand) => unknown,
): StepContext<Params> {
  const s3 = {
    async send(command: FakeCommand) {
      const reply = send(command);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
  return {
    params: PARAMS,
    creds: {},
    clients: { aws: { s3, iam: s3, sts: s3, ec2: s3, ssm: s3, secretsManager: s3, ecr: s3, region: "us-east-1" } },
    accountId: ACCOUNT,
    outputs,
    dryRun: false,
    log: NO_LOG,
  };
}

describe("snowpipe-auto-ingest: pipeStep", () => {
  test("check() missing when SHOW PIPES has no exact match", async () => {
    const ctx = snowflakeCtx({}, async () => []);
    expect(await pipeStep.check(ctx)).toBe("missing");
  });

  test("check() exists reads notification_channel into outputs", async () => {
    const outputs: Record<string, unknown> = {};
    const ctx = snowflakeCtx(outputs, async () =>
      [{ name: "FERRY_PIPE", notification_channel: "arn:aws:sqs:us-east-1:123:sf-queue" }],
    );
    expect(await pipeStep.check(ctx)).toBe("exists");
    expect(outputs.notificationChannel).toBe("arn:aws:sqs:us-east-1:123:sf-queue");
  });

  test("create() issues CREATE PIPE then reads back the notification channel", async () => {
    const sent: string[] = [];
    const ctx = snowflakeCtx({}, async (sql) => {
      sent.push(sql);
      if (sql.startsWith("CREATE PIPE")) return [];
      return [{ name: "FERRY_PIPE", notification_channel: "arn:aws:sqs:us-east-1:123:sf-queue" }];
    });
    const outputs = await pipeStep.create!(ctx);
    expect(outputs.pipeCreatedThisRun).toBe(true);
    expect(outputs.notificationChannel).toBe("arn:aws:sqs:us-east-1:123:sf-queue");
    expect(sent[0]).toContain("CREATE PIPE ferry_pipe AUTO_INGEST = TRUE AS COPY INTO raw.events FROM @ferry_stage");
  });

  test("create() throws if SHOW PIPES reports no notification_channel after creation", async () => {
    const ctx = snowflakeCtx({}, async (sql) => (sql.startsWith("CREATE PIPE") ? [] : [{ name: "FERRY_PIPE" }]));
    await expect(pipeStep.create!(ctx)).rejects.toThrow(/did not report a notification_channel/);
  });

  test("rollback() drops the pipe only if this run created it", async () => {
    const sent: string[] = [];
    const ctxNotCreated = snowflakeCtx({}, async (sql) => {
      sent.push(sql);
      return [];
    });
    await pipeStep.rollback(ctxNotCreated);
    expect(sent).toEqual([]);

    const ctxCreated = snowflakeCtx({ pipeCreatedThisRun: true }, async (sql) => {
      sent.push(sql);
      return [];
    });
    await pipeStep.rollback(ctxCreated);
    expect(sent).toEqual(["DROP PIPE IF EXISTS ferry_pipe;"]);
  });
});

describe("snowpipe-auto-ingest: bucketNotificationStep", () => {
  const entryId = notificationEntryId(PARAMS.SF_PIPE_NAME);

  test("reconcile() merges its own entry alongside an unrelated existing one", async () => {
    const puts: FakeCommand[] = [];
    const ctx = s3Ctx({ notificationChannel: "arn:aws:sqs:us-east-1:123:sf-queue" }, (cmd) => {
      if (cmd.constructor.name === "GetBucketNotificationConfigurationCommand") {
        return {
          QueueConfigurations: [{ Id: "someone-elses-rule", QueueArn: "arn:aws:sqs:us-east-1:123:other" }],
        };
      }
      if (cmd.constructor.name === "PutBucketNotificationConfigurationCommand") {
        puts.push(cmd);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });

    await bucketNotificationStep.reconcile!(ctx);
    expect(puts).toHaveLength(1);
    const queues = (puts[0]!.input.NotificationConfiguration as { QueueConfigurations: { Id: string }[] })
      .QueueConfigurations;
    expect(queues.map((q) => q.Id).sort()).toEqual([entryId, "someone-elses-rule"].sort());
  });

  test("reconcile() is a no-op when the owned entry already matches", async () => {
    const puts: FakeCommand[] = [];
    const ctx = s3Ctx({ notificationChannel: "arn:aws:sqs:us-east-1:123:sf-queue" }, (cmd) => {
      if (cmd.constructor.name === "GetBucketNotificationConfigurationCommand") {
        return {
          QueueConfigurations: [
            {
              Id: entryId,
              QueueArn: "arn:aws:sqs:us-east-1:123:sf-queue",
              Events: ["s3:ObjectCreated:*"],
              Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "landing/" }] } },
            },
          ],
        };
      }
      if (cmd.constructor.name === "PutBucketNotificationConfigurationCommand") puts.push(cmd);
      return {};
    });
    await bucketNotificationStep.reconcile!(ctx);
    expect(puts).toHaveLength(0);
  });

  test("rollback() removes only its own entry, leaving unrelated ones intact", async () => {
    const puts: FakeCommand[] = [];
    const ctx = s3Ctx({ notificationEntryAddedThisRun: true }, (cmd) => {
      if (cmd.constructor.name === "GetBucketNotificationConfigurationCommand") {
        return {
          QueueConfigurations: [
            { Id: entryId, QueueArn: "arn:aws:sqs:us-east-1:123:sf-queue" },
            { Id: "someone-elses-rule", QueueArn: "arn:aws:sqs:us-east-1:123:other" },
          ],
        };
      }
      if (cmd.constructor.name === "PutBucketNotificationConfigurationCommand") {
        puts.push(cmd);
        return {};
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    });
    await bucketNotificationStep.rollback(ctx);
    const queues = (puts[0]!.input.NotificationConfiguration as { QueueConfigurations: { Id: string }[] })
      .QueueConfigurations;
    expect(queues.map((q) => q.Id)).toEqual(["someone-elses-rule"]);
  });

  test("rollback() no-ops if this run never added an entry", async () => {
    const puts: FakeCommand[] = [];
    const ctx = s3Ctx({}, (cmd) => {
      puts.push(cmd);
      return {};
    });
    await bucketNotificationStep.rollback(ctx);
    expect(puts).toHaveLength(0);
  });
});
