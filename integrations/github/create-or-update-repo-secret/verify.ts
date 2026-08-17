import type { StepContext } from "../../../src/core/define";
import { githubClients, secretExists } from "../../../src/providers/github";
import type { Params } from "./params";

/**
 * Can only confirm presence — GitHub never returns a secret's value, so
 * this cannot verify the value actually took effect (that would require a
 * live workflow run reading the secret, out of scope here).
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, SECRET_NAME } = ctx.params;

  const exists = await secretExists(rest, { kind: "repo", owner: OWNER, repo: REPO }, SECRET_NAME);
  if (!exists) throw new Error(`Secret "${SECRET_NAME}" does not exist on ${OWNER}/${REPO} after apply`);

  ctx.log.success(
    `Confirmed secret "${SECRET_NAME}" exists on ${OWNER}/${REPO} (value cannot be verified — write-blind API)`,
  );
}
