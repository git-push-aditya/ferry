import snowflake from "snowflake-sdk";
import type { SnowflakeCredentials } from "./credentials";

export const SNOWFLAKE_PROVIDER_ID = "snowflake";
export type SnowflakeRow = Record<string, unknown>;

/** Accepts either a raw PEM string or the whole PEM base64-encoded (common when squeezing a multi-line key onto one .env line). */
export function decodePrivateKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  return Buffer.from(trimmed, "base64").toString("utf8");
}

export interface SnowflakeConnection {
  connection: snowflake.Connection;
  runQuery: (sqlText: string) => Promise<SnowflakeRow[]>;
  close: () => Promise<void>;
}

export function connect(env: SnowflakeCredentials): Promise<SnowflakeConnection> {
  const options: snowflake.ConnectionOptions = {
    account: env.SNOWFLAKE_ACCOUNT,
    username: env.SNOWFLAKE_USERNAME,
    role: env.SNOWFLAKE_ROLE,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    database: env.SNOWFLAKE_DATABASE,
    schema: env.SNOWFLAKE_SCHEMA,
  };

  if (env.SNOWFLAKE_PRIVATE_KEY?.trim()) {
    options.authenticator = "SNOWFLAKE_JWT";
    options.privateKey = decodePrivateKey(env.SNOWFLAKE_PRIVATE_KEY);
    if (env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE?.trim()) {
      options.privateKeyPass = env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE;
    }
  } else {
    options.password = env.SNOWFLAKE_PASSWORD;
  }

  const connection = snowflake.createConnection(options);

  return new Promise((resolve, reject) => {
    connection.connect((err, conn) => {
      if (err) {
        reject(err);
        return;
      }

      const runQuery = (sqlText: string): Promise<SnowflakeRow[]> =>
        new Promise((res, rej) => {
          conn.execute({
            sqlText,
            complete: (queryErr, _stmt, rows) => {
              if (queryErr) {
                rej(queryErr);
                return;
              }
              res(rows ?? []);
            },
          });
        });

      const close = (): Promise<void> =>
        new Promise((res, rej) => {
          conn.destroy((destroyErr) => {
            if (destroyErr) rej(destroyErr);
            else res();
          });
        });

      resolve({ connection: conn, runQuery, close });
    });
  });
}

/**
 * One lazily-opened connection, shared by every step of a run.
 *
 * The engine disposes it *after* rollback has finished, because rollback needs
 * a live connection to DROP the Snowflake objects a failed run created.
 */
export interface SnowflakeClients {
  /** Opens the shared connection on first call and self-checks it with SELECT 1. */
  connection(): Promise<SnowflakeConnection>;
  /** The open connection, or undefined if nothing has connected yet. */
  peek(): SnowflakeConnection | undefined;
  close(): Promise<void>;
}

export function makeSnowflakeClients(env: SnowflakeCredentials): SnowflakeClients {
  let opened: SnowflakeConnection | undefined;
  let opening: Promise<SnowflakeConnection> | undefined;

  return {
    connection() {
      if (opened) return Promise.resolve(opened);
      opening ??= (async () => {
        const conn = await connect(env);
        // Verifies snowflake-sdk connects and runs a query under the current
        // runtime (see README on bun/Node fallback).
        const rows = await conn.runQuery("SELECT 1 AS OK");
        if (!rows.length || rows[0]?.OK !== 1) {
          await conn.close();
          throw new Error("SELECT 1 self-check did not return the expected row");
        }
        opened = conn;
        return conn;
      })();
      return opening;
    },
    peek() {
      return opened;
    },
    async close() {
      const conn = opened;
      opened = undefined;
      opening = undefined;
      if (conn) await conn.close();
    },
  };
}

/** Typed accessor so steps don't cast `ctx.clients` themselves. */
export function snowflakeClients(ctx: { clients: Record<string, unknown> }): SnowflakeClients {
  const clients = ctx.clients[SNOWFLAKE_PROVIDER_ID] as SnowflakeClients | undefined;
  if (!clients) {
    throw new Error(
      `This step needs Snowflake clients — add "snowflake" to the integration's credentials`,
    );
  }
  return clients;
}
