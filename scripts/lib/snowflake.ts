import snowflake from "snowflake-sdk";
import type { IntegrationEnv } from "./env";

export interface SnowflakeConnection {
  connection: snowflake.Connection;
  runQuery: (sqlText: string) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

export function connect(env: IntegrationEnv): Promise<SnowflakeConnection> {
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
    options.privateKey = env.SNOWFLAKE_PRIVATE_KEY;
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

      const runQuery = (sqlText: string): Promise<Record<string, unknown>[]> =>
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

/** Verifies snowflake-sdk connects and runs a query under the current runtime (see README on bun/Node fallback). */
export async function selfCheck(env: IntegrationEnv): Promise<void> {
  const conn = await connect(env);
  try {
    const rows = await conn.runQuery("SELECT 1 AS OK");
    if (!rows.length || rows[0]?.OK !== 1) {
      throw new Error("SELECT 1 self-check did not return the expected row");
    }
  } finally {
    await conn.close();
  }
}
