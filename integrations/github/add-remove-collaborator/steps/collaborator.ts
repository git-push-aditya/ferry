import type { Step } from "../../../../src/core/define";
import {
  collaboratorState,
  getCollaboratorPermission,
  githubClients,
  putCollaborator,
  removeCollaborator,
  repoState,
} from "../../../../src/providers/github";
import type { Params } from "../params";

/**
 * Single step, single collaborator — a create-or-skip toggle per direction,
 * same shape as aws/ec2/stop-start-instance. GitHub's collaborator
 * endpoints are PUT/DELETE against a fixed resource (idempotent by verb), so
 * check()'s skip is reinforcement, not the only safety net.
 *
 * One documented gap (see docs/plan/github.md task 3): there is no dedicated
 * pending-invitation endpoint, so a user who has a pending invite but hasn't
 * accepted yet still reads as 404 ("not a collaborator") on the direct
 * check — this cannot distinguish "never invited" from "invited, not yet
 * accepted."
 *
 * The repo-existence check lives inside check() itself (rather than as a
 * separate guard step) so a missing repo still aborts in the plan phase,
 * before any mutation, while keeping this a true one-step task.
 */
export const collaboratorStep: Step<Params> = {
  id: "collaborator",
  title: "Add or remove a repo collaborator",

  async check(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, USERNAME, ACTION } = ctx.params;

    if ((await repoState(rest, OWNER, REPO)) === "missing") {
      ctx.log.warn(`Repo "${OWNER}/${REPO}" does not exist — run github/create-repo first.`);
      return "conflict";
    }

    const state = await collaboratorState(rest, OWNER, REPO, USERNAME);
    const isMember = state === "member";

    if (ACTION === "add") return isMember ? "exists" : "missing";
    return isMember ? "missing" : "exists"; // remove: inverted
  },

  async create(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, USERNAME, ACTION, PERMISSION } = ctx.params;

    if (ACTION === "add") {
      // Confirmed response codes: 201 = new invitation created, 204 = user
      // already had access and nothing changed status-wise — the API gives
      // no signal distinguishing a true no-op from a silent permission
      // change on that 204, so this only reports "ensured", never "no
      // changes made" with certainty.
      const result = await putCollaborator(rest, OWNER, REPO, USERNAME, PERMISSION!);
      ctx.log.success(
        result.invitationCreated
          ? `Invited ${USERNAME} to ${OWNER}/${REPO} at ${PERMISSION}`
          : `${USERNAME} already had access to ${OWNER}/${REPO} — ensured at ${PERMISSION} (no invitation needed)`,
      );
      return {
        collaboratorAddedThisRun: true,
        collaboratorInvitationCreated: result.invitationCreated,
      };
    }

    // remove: capture the current permission level before removing, so
    // rollback can restore it exactly — the collaborator-by-username GET
    // itself doesn't return a permission field, hence the extra read here.
    const priorPermission = await getCollaboratorPermission(rest, OWNER, REPO, USERNAME);
    await removeCollaborator(rest, OWNER, REPO, USERNAME);
    ctx.log.success(`Removed ${USERNAME} from ${OWNER}/${REPO}`);
    return {
      collaboratorRemovedThisRun: true,
      collaboratorPriorPermission: priorPermission ?? "",
    };
  },

  async rollback(ctx) {
    const { rest } = githubClients(ctx);
    const { OWNER, REPO, USERNAME, ACTION } = ctx.params;

    if (ACTION === "add" && ctx.outputs.collaboratorAddedThisRun === true) {
      if (ctx.outputs.collaboratorInvitationCreated === false) {
        ctx.log.warn(
          `${USERNAME} may have already had access to ${OWNER}/${REPO} via org/team membership before ` +
            `this run (the API gave no signal either way) — removing the explicit grant this run made, ` +
            `but any prior permission level from that indirect access was never captured and cannot be restored.`,
        );
      }
      await removeCollaborator(rest, OWNER, REPO, USERNAME);
      return;
    }

    if (ACTION === "remove" && ctx.outputs.collaboratorRemovedThisRun === true) {
      const priorPermission = String(ctx.outputs.collaboratorPriorPermission ?? "");
      if (!priorPermission) {
        ctx.log.warn(
          `No prior permission level was captured for ${USERNAME} on ${OWNER}/${REPO} — cannot restore exactly.`,
        );
        return;
      }
      await putCollaborator(rest, OWNER, REPO, USERNAME, priorPermission);
    }
  },

  resource(ctx) {
    const { OWNER, REPO, USERNAME, ACTION, PERMISSION } = ctx.params;
    return {
      type: "github_collaborator",
      name: `${OWNER}/${REPO}:${USERNAME}`,
      attributes: {
        owner: OWNER,
        repo: REPO,
        username: USERNAME,
        ...(ACTION === "add" ? { permission: PERMISSION ?? "" } : { action: "removed" }),
      },
    };
  },
};
