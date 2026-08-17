import type { StepContext } from "../../../src/core/define";
import { getWebhook, githubClients } from "../../../src/providers/github";
import type { Params } from "./params";

export async function verify(ctx: StepContext<Params>): Promise<void> {
  const { rest } = githubClients(ctx);
  const { OWNER, REPO, URL, ACTIVE } = ctx.params;
  const hookId = ctx.outputs.webhookId as number | undefined;
  if (hookId === undefined) throw new Error("No webhook id was captured to verify");

  const hook = await getWebhook(rest, OWNER, REPO, hookId);
  if (!hook) throw new Error(`Webhook ${hookId} on ${OWNER}/${REPO} does not exist after apply`);
  if (hook.config.url !== URL) throw new Error(`Webhook ${hookId} url is "${hook.config.url}", expected "${URL}"`);
  if (hook.active !== ACTIVE) throw new Error(`Webhook ${hookId} active=${hook.active}, expected ${ACTIVE}`);

  ctx.log.success(`Confirmed webhook ${hookId} on ${OWNER}/${REPO} matches requested url/active`);
}
