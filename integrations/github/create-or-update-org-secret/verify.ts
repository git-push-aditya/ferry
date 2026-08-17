import type { StepContext } from "../../../src/core/define";
import { getOrgSecretVisibility, githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { ORG, SECRET_NAME, VISIBILITY } = ctx.params;

  const current = await getOrgSecretVisibility(rest, ORG, SECRET_NAME);
  if (!current) throw new Error(`Org secret "${SECRET_NAME}" does not exist on ${ORG} after apply`);
  if (current.visibility !== VISIBILITY) {
    throw new Error(
      `Org secret "${SECRET_NAME}" visibility is "${current.visibility}", expected "${VISIBILITY}"`,
    );
  }

  ctx.log.success(
    `Confirmed org secret "${SECRET_NAME}" exists on ${ORG} with visibility "${VISIBILITY}" ` +
      `(value cannot be verified — write-blind API)`,
  );
}
