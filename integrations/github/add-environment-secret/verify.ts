import type { StepContext } from "../../../src/core/define";
import { githubClients, secretExists } from "../../../src/providers/github";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, ENVIRONMENT_NAME, SECRET_NAME } = ctx.params;

  const exists = await secretExists(
    rest,
    { kind: "environment", owner: OWNER, repo: REPO, environment: ENVIRONMENT_NAME },
    SECRET_NAME,
  );
  if (!exists) throw new Error(`Secret "${SECRET_NAME}" does not exist on ${OWNER}/${REPO}:${ENVIRONMENT_NAME} after apply`);

  ctx.log.success(
    `Confirmed secret "${SECRET_NAME}" exists on ${OWNER}/${REPO}:${ENVIRONMENT_NAME} (value cannot be verified — write-blind API)`,
  );
}
