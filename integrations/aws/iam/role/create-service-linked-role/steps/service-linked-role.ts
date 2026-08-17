import {
  CreateServiceLinkedRoleCommand,
  DeleteServiceLinkedRoleCommand,
  GetServiceLinkedRoleDeletionStatusCommand,
} from "@aws-sdk/client-iam";
import type { Step } from "../../../../../../src/core/define";
import { pollUntil } from "../../../../../../src/core/wait";
import { awsClients, roleState } from "../../../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Create-or-skip for a service-linked role.
 *
 * check() probes EXPECTED_ROLE_NAME directly via roleState — the caller
 * looked up the exact fixed-or-suffixed name from AWS's own per-service
 * documentation ahead of time. This sidesteps the genuine per-service
 * variance in what "already exists" means for CreateServiceLinkedRole (some
 * services are singleton-per-account, others allow multiple via
 * CustomSuffix, and the API reference does not enumerate a master list) —
 * Ferry never relies on the create call's own idempotency here; the
 * check()-first gate is the load-bearing safety mechanism.
 */
export const serviceLinkedRoleStep: Step<Params> = {
  id: "create-service-linked-role",
  title: "Create the service-linked role",

  async check(ctx) {
    return roleState(awsClients(ctx).iam, ctx.params.EXPECTED_ROLE_NAME);
  },

  async create(ctx) {
    const { iam } = awsClients(ctx);
    const created = await iam.send(
      new CreateServiceLinkedRoleCommand({
        AWSServiceName: ctx.params.AWS_SERVICE_NAME,
        CustomSuffix: ctx.params.CUSTOM_SUFFIX,
        Description: ctx.params.DESCRIPTION,
      }),
    );

    ctx.log.success(
      `Created service-linked role ${created.Role?.RoleName ?? ctx.params.EXPECTED_ROLE_NAME}`,
    );

    return {
      roleArn: created.Role?.Arn,
      roleName: created.Role?.RoleName,
      serviceLinkedRoleCreatedThisRun: true,
    };
  },

  /**
   * Best-effort. Service-linked roles cannot be removed with a plain
   * DeleteRoleCommand (throws UnmodifiableEntity) — deletion is async via
   * DeleteServiceLinkedRole + a polled deletion-task status. Never throws:
   * rollback must not itself mask the original failure that triggered it. A
   * FAILED deletion task's Reason is surfaced as a loud warning, since that
   * is exactly the case where a human must intervene in the owning service.
   */
  async rollback(ctx) {
    const { iam } = awsClients(ctx);
    const roleName = (ctx.outputs.roleName as string | undefined) ?? ctx.params.EXPECTED_ROLE_NAME;

    let deletionTaskId: string | undefined;
    try {
      const deleted = await iam.send(new DeleteServiceLinkedRoleCommand({ RoleName: roleName }));
      deletionTaskId = deleted.DeletionTaskId;
    } catch (err) {
      ctx.log.warn(
        `Could not start deletion of service-linked role ${roleName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (!deletionTaskId) {
      ctx.log.warn(`DeleteServiceLinkedRole for ${roleName} returned no DeletionTaskId to poll`);
      return;
    }

    let finalStatus: string | undefined;
    let failureReason: string | undefined;
    await pollUntil(
      async () => {
        const status = await iam.send(
          new GetServiceLinkedRoleDeletionStatusCommand({ DeletionTaskId: deletionTaskId }),
        );
        finalStatus = status.Status;
        failureReason = status.Reason?.Reason;
        return status.Status === "SUCCEEDED" || status.Status === "FAILED";
      },
      { intervalMs: 5_000, timeoutMs: 120_000, label: `deletion of ${roleName}` },
    );

    if (finalStatus === "FAILED") {
      ctx.log.warn(
        `Deletion of service-linked role ${roleName} FAILED: ${failureReason ?? "no reason given"}. ` +
          `Manual cleanup in the owning service is required (task ${deletionTaskId}).`,
      );
    } else if (finalStatus !== "SUCCEEDED") {
      ctx.log.warn(
        `Deletion of service-linked role ${roleName} did not confirm within the timeout — check task ${deletionTaskId} manually.`,
      );
    }
  },

  resource(ctx) {
    const roleName = (ctx.outputs.roleName as string | undefined) ?? ctx.params.EXPECTED_ROLE_NAME;
    const arn = (ctx.outputs.roleArn as string | undefined) ?? "";
    return {
      type: "aws_iam_service_linked_role",
      name: roleName,
      attributes: {
        arn,
        awsServiceName: ctx.params.AWS_SERVICE_NAME,
        customSuffix: ctx.params.CUSTOM_SUFFIX ?? "",
      },
    };
  },
};
