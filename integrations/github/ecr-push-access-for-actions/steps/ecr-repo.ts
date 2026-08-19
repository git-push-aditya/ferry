import { CreateRepositoryCommand, DeleteRepositoryCommand } from "@aws-sdk/client-ecr";
import type { Step } from "../../../../src/core/define";
import { awsClients, ecrRepositoryArn, ecrRepositoryState } from "../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * Create-only, same "no settings-drift reconcile" stance as
 * github/create-environment — imageTagMutability is set once at creation
 * and this step does not promise to reconcile it later.
 *
 * imageScanningConfiguration is deliberately omitted here: it is on a
 * deprecation path in favor of registry-level scan configuration, so this
 * step does not present a deprecated per-repo option as current best
 * practice — see README.
 */
export const ecrRepoStep: Step<Params> = {
  id: "ecr-repo",
  title: "Create ECR repository",

  async check(ctx) {
    return ecrRepositoryState(awsClients(ctx).ecr, ctx.params.ECR_REPOSITORY_NAME);
  },

  async create(ctx) {
    await awsClients(ctx).ecr.send(
      new CreateRepositoryCommand({
        repositoryName: ctx.params.ECR_REPOSITORY_NAME,
        imageTagMutability: ctx.params.IMAGE_TAG_MUTABILITY,
      }),
    );
    ctx.log.success(`Created ECR repository "${ctx.params.ECR_REPOSITORY_NAME}"`);
    return { ecrRepoCreatedThisRun: true };
  },

  async rollback(ctx) {
    if (ctx.outputs.ecrRepoCreatedThisRun !== true) return;
    if (!ctx.params.ALLOW_DESTRUCTIVE_ROLLBACK) {
      ctx.log.warn(
        `Not deleting ECR repository "${ctx.params.ECR_REPOSITORY_NAME}" on rollback — ` +
          `set ALLOW_DESTRUCTIVE_ROLLBACK=true to allow this. Any images pushed since ` +
          `creation would be permanently lost.`,
      );
      return;
    }
    await awsClients(ctx).ecr.send(
      new DeleteRepositoryCommand({ repositoryName: ctx.params.ECR_REPOSITORY_NAME, force: true }),
    );
  },

  resource(ctx) {
    return {
      type: "aws_ecr_repository",
      name: ctx.params.ECR_REPOSITORY_NAME,
      attributes: {
        name: ctx.params.ECR_REPOSITORY_NAME,
        arn: ecrRepositoryArn(ctx.accountId, awsClients(ctx).region, ctx.params.ECR_REPOSITORY_NAME),
        imageTagMutability: ctx.params.IMAGE_TAG_MUTABILITY,
      },
    };
  },

  handoff: {
    terraform: {
      type: "aws_ecr_repository",
      address: "aws_ecr_repository.this",
      importId: (ctx) => ctx.params.ECR_REPOSITORY_NAME,
    },
  },
};
