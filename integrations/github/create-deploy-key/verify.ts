import type { StepContext } from "../../../src/core/define";
import { githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

interface DeployKey {
  id: number;
  read_only?: boolean;
}

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, READ_ONLY } = ctx.params;
  const keyId = ctx.outputs.deployKeyId as number | undefined;
  if (keyId === undefined) throw new Error("No deploy key id was captured to verify");

  const res = await rest.request<DeployKey>("GET", `/repos/${OWNER}/${REPO}/keys/${keyId}`);
  if (Boolean(res.data.read_only) !== READ_ONLY) {
    throw new Error(`Deploy key ${keyId} on ${OWNER}/${REPO} has read_only=${res.data.read_only}, expected ${READ_ONLY}`);
  }

  ctx.log.success(`Confirmed deploy key ${keyId} on ${OWNER}/${REPO} matches requested read_only`);
}
