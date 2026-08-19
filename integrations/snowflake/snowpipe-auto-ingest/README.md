# `snowflake/snowpipe-auto-ingest`

Wires an S3 bucket to a Snowflake `PIPE` for continuous, event-driven
ingestion — the classic "did it once by hand across two different
consoles, wrote it down somewhere, lost the notes" setup.

```bash
bun run bin/ferry.ts snowflake/snowpipe-auto-ingest --dry-run
bun run bin/ferry.ts snowflake/snowpipe-auto-ingest
```

## What it creates

| Step | Resource | Notes |
| --- | --- | --- |
| `snowflake-connect` | — | opens the Snowflake connection |
| `stage-exists` | (guard) confirms `SF_STAGE_NAME` already exists | conflict if it doesn't — run `snowflake/create-storage-s3-integration` first |
| `pipe` | the `PIPE` object | create-only; reads back `notification_channel` regardless of which branch ran |
| `bucket-notification` | one `QueueConfiguration` entry on the bucket | always-reconcile, merged — never a blind overwrite of the bucket's other notification rules |
| `verify` | uploads a real test object and polls `SYSTEM$PIPE_STATUS` | — |

## What it needs

**Root `.env`** — `credentials: ["aws", "snowflake"]`.

**This folder's `.env`** — see `.env.example`: `SF_PIPE_NAME`,
`SF_TARGET_TABLE`, `SF_STAGE_NAME`, `SF_FILE_FORMAT`, `S3_BUCKET_NAME`,
`S3_INGEST_PREFIX`.

## Gotchas

**Pipe-first ordering is a hard, non-rearrangeable dependency.** Snowflake
mints and owns the SQS queue a pipe listens on — the queue's ARN is only
knowable by reading it back off the created pipe (`SHOW PIPES` →
`notification_channel`). The bucket notification step cannot run before
the pipe exists.

**No IAM/SQS policy step anywhere in this integration.** Confirmed:
Snowpipe SQS queues are created and managed by Snowflake — the customer
side never creates a queue and never grants IAM permissions on one. The
only genuinely new AWS-side action is pointing the bucket's own event
notification configuration at the queue ARN Snowflake already owns.

**`PutBucketNotificationConfiguration` is a full-document-replace API, and
this step treats it as dangerous to overwrite blindly.** A bucket may
already have unrelated notification rules from other pipelines or other
tools. `bucket-notification` always re-reads the current configuration,
touches only the one `QueueConfiguration` entry it owns (matched by a
stable, deterministic `Id` — see `notificationEntryId` in `params.ts`),
and writes the merged result back. Rollback removes only that one entry,
re-reading fresh state rather than restoring a stale captured snapshot.

**No settings-drift reconcile on the pipe itself.** Changing a pipe's
`COPY INTO` definition after creation requires `ALTER PIPE ... SET
PIPE_EXECUTION_PAUSED = TRUE` first — a disruptive operation this
integration does not attempt automatically. Changing `SF_TARGET_TABLE` or
`SF_FILE_FORMAT` after the pipe exists has no effect until you pause and
recreate it by hand.
