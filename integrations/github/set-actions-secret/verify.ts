import type { StepContext } from "../../../src/core/define";
import { githubClients, secretExists } from "../../../src/providers/github";
import { scopeOf, targetOf, type Params } from "./params";

/**
 * Can only confirm presence — GitHub never returns a secret's value, so this
 * cannot verify the value actually took effect (that would require a live
 * workflow run reading the secret, out of scope here). At org scope the
 * visibility IS readable, so that part is genuinely verified.
 */
export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const p = ctx.params;
  const target = targetOf(p);

  const exists = await secretExists(rest, scopeOf(p), p.SECRET_NAME);
  if (!exists) throw new Error(`Secret "${p.SECRET_NAME}" does not exist on ${target} after apply`);

  ctx.log.success(
    `Confirmed secret "${p.SECRET_NAME}" exists on ${target} (value cannot be verified — write-blind API)`,
  );

  if (p.SCOPE === "org") {
    const { getOrgSecretVisibility } = await import("../../../src/providers/github");
    const current = await getOrgSecretVisibility(rest, p.ORG!, p.SECRET_NAME);
    if (!current) throw new Error(`Org secret "${p.SECRET_NAME}" vanished between apply and verify`);
    if (current.visibility !== p.VISIBILITY) {
      throw new Error(
        `Expected org secret "${p.SECRET_NAME}" visibility "${p.VISIBILITY}", read back "${current.visibility}"`,
      );
    }
    ctx.log.success(`Confirmed org secret visibility is "${p.VISIBILITY}"`);
  }
}
