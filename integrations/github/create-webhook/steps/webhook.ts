import type { Step } from "../../../../src/core/define";
import {
  createWebhook,
  deleteWebhook,
  findWebhookByConfig,
  githubClients,
  listWebhooks,
  pingWebhook,
  repoState,
} from "../../../../src/providers/github";
import type { Params } from "../params";

/**
 * URL is NOT a uniqueness key — confirmed: "multiple webhooks can share the
 * same config." This is the one task in this provider (and, per
 * docs/plan/github.md, across this whole project's history) where check()
 * cannot be made fully ownership-safe by any API-level mechanism GitHub
 * exposes: a second, unrelated webhook with an identical URL and event list
 * would false-positive as "exists". Deliberately create-or-skip despite the
 * identity fuzziness — an always-reconcile here would risk silently
 * mutating a webhook this integration doesn't actually own.
 */
export const webhookStep: Step<Params> = {
  id: "webhook",
  title: "Create a repo webhook",

  async check(ctx) {
    const clients = githubClients(ctx);
    const { OWNER, REPO, URL, EVENTS } = ctx.params;

    if ((await repoState(clients.rest, OWNER, REPO)) === "missing") {
      ctx.log.warn(`Repo "${OWNER}/${REPO}" does not exist — run github/create-repo first.`);
      return "conflict";
    }

    const hooks = await listWebhooks(clients.rest, OWNER, REPO);
    return findWebhookByConfig(hooks, URL, EVENTS) ? "exists" : "missing";
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, URL, CONTENT_TYPE, SECRET, EVENTS, ACTIVE } = ctx.params;

    const hook = await createWebhook(rest, OWNER, REPO, {
      url: URL,
      contentType: CONTENT_TYPE,
      secret: SECRET,
      events: EVENTS,
      active: ACTIVE,
    });

    // A failed ping doesn't fail create() — the hook is legitimately created
    // either way; a failed ping just means the receiving endpoint isn't up yet.
    const pinged = await pingWebhook(rest, OWNER, REPO, hook.id).catch(() => false);
    if (!pinged) ctx.log.warn(`Webhook ${hook.id} created but the connectivity ping did not succeed`);

    ctx.log.success(`Created webhook ${hook.id} on ${OWNER}/${REPO} for events: ${EVENTS.join(", ")}`);
    return { webhookId: hook.id, webhookCreatedThisRun: true };
  },

  async rollback(ctx) {
    const hookId = ctx.outputs.webhookId as number | undefined;
    if (hookId === undefined) return;
    const { rest } = githubClients(ctx);
    await deleteWebhook(rest, ctx.params.OWNER, ctx.params.REPO, hookId);
  },

  resource(ctx) {
    const { OWNER, REPO, URL } = ctx.params;
    return {
      type: "github_webhook",
      name: `${OWNER}/${REPO}:${ctx.outputs.webhookId ?? ""}`,
      attributes: { owner: OWNER, repo: REPO, hookId: String(ctx.outputs.webhookId ?? ""), url: URL },
    };
  },
};
