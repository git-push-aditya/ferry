import type { Step, StepState } from "../../core/define";
import type { GithubClient } from "./client";
import { githubClients } from "./client";
import { GithubApiError } from "./errors";

export interface RepoIdentity<P> {
  owner(params: P): string;
  repo(params: P): string;
}

/**
 * Repo names are unique per-owner, not globally like S3 bucket names —
 * confirmed against the fetched repos docs (docs/plan/github.md task 1). A
 * successful GET always means either "this owner's repo" or "some other
 * owner's repo entirely" — there is no ambiguous middle case the way S3's
 * global bucket namespace forces, since the owner segment of the path is
 * itself the disambiguator. So `check()` only ever needs 404-vs-200.
 */
export async function repoState(client: GithubClient, owner: string, repo: string): Promise<StepState> {
  const path = `/repos/${owner}/${repo}`;
  const res = await client.raw("GET", path);
  if (res.status === 404) return "missing";
  if (res.status === 200) return "exists";
  throw new GithubApiError("GET", path, res.status, res.data);
}

/**
 * Precondition step for integrations that operate on a repo they do not
 * create (collaborators, branch protection, secrets, webhooks, ...). Mirrors
 * iamRoleExistsGuardStep: "missing" folds to "conflict" here because this
 * step declares no create() — without this, a missing repo would silently
 * plan a "skip" and the real failure would only surface as a raw 404
 * partway through apply.
 */
export function githubRepoExistsGuardStep<P>(
  opts: RepoIdentity<P> & { id?: string; title?: string },
): Step<P> {
  return {
    id: opts.id ?? "github-repo-exists",
    title: opts.title ?? "Confirm the GitHub repo already exists",

    async check(ctx) {
      const { rest } = githubClients(ctx);
      const owner = opts.owner(ctx.params);
      const repo = opts.repo(ctx.params);
      const state = await repoState(rest, owner, repo);
      if (state === "missing") {
        ctx.log.warn(
          `Repo "${owner}/${repo}" does not exist. This integration operates on an existing repo ` +
            `and does not create one — run github/create-repo first if you need it provisioned.`,
        );
        return "conflict";
      }
      return state;
    },

    async rollback() {
      // A read-only precondition changes nothing, so there is nothing to undo.
    },
  };
}

export interface RepoStepOptions<P> extends RepoIdentity<P> {
  /** "org" posts to /orgs/{owner}/repos; "user" posts to /user/repos (the authenticated account). */
  ownerType(params: P): "user" | "org";
  description?(params: P): string | undefined;
  visibility?(params: P): "public" | "private" | undefined;
  autoInit?(params: P): boolean;
  gitignoreTemplate?(params: P): string | undefined;
  licenseTemplate?(params: P): string | undefined;
  /** Real, irreversible data loss otherwise — see task 1's rollback design in docs/plan/github.md. */
  allowDestructiveRollback(params: P): boolean;
  id?: string;
  title?: string;
}

interface CreatedRepo {
  html_url?: string;
  private?: boolean;
  visibility?: string;
}

/**
 * Creates a repo under a user or org account. create-only, mirroring
 * iamRoleStep's shape: no "exists but isn't ours" third state is possible
 * (see repoState's own doc comment), so check() is a bare presence probe.
 */
export function githubRepoStep<P>(opts: RepoStepOptions<P>): Step<P> {
  return {
    id: opts.id ?? "github-repo",
    title: opts.title ?? "Ensure GitHub repo",

    async check(ctx) {
      const { rest } = githubClients(ctx);
      return repoState(rest, opts.owner(ctx.params), opts.repo(ctx.params));
    },

    async create(ctx) {
      const { rest } = githubClients(ctx);
      const owner = opts.owner(ctx.params);
      const repo = opts.repo(ctx.params);
      const ownerType = opts.ownerType(ctx.params);
      const path = ownerType === "org" ? `/orgs/${owner}/repos` : "/user/repos";

      const res = await rest.request<CreatedRepo>("POST", path, {
        okStatuses: [201],
        body: {
          name: repo,
          description: opts.description?.(ctx.params),
          visibility: opts.visibility?.(ctx.params),
          // Needed because several downstream tasks (branch-protection) 404
          // against a fully-empty repo with no default branch yet.
          auto_init: opts.autoInit?.(ctx.params) ?? true,
          gitignore_template: opts.gitignoreTemplate?.(ctx.params),
          license_template: opts.licenseTemplate?.(ctx.params),
        },
      });

      return {
        githubRepoCreatedThisRun: true,
        githubRepoHtmlUrl: res.data.html_url ?? "",
      };
    },

    async rollback(ctx) {
      const owner = opts.owner(ctx.params);
      const repo = opts.repo(ctx.params);
      if (!opts.allowDestructiveRollback(ctx.params)) {
        ctx.log.warn(
          `NOT deleting repo "${owner}/${repo}" on rollback — set ALLOW_DESTRUCTIVE_ROLLBACK=true to ` +
            `allow this. Everything committed to the repo since it was created would be lost for good.`,
        );
        return;
      }
      const { rest } = githubClients(ctx);
      await rest.request("DELETE", `/repos/${owner}/${repo}`, { okStatuses: [204, 404] });
    },

    resource(ctx) {
      const owner = opts.owner(ctx.params);
      const repo = opts.repo(ctx.params);
      return {
        type: "github_repo",
        name: `${owner}/${repo}`,
        attributes: {
          owner,
          name: repo,
          htmlUrl: String(ctx.outputs.githubRepoHtmlUrl ?? ""),
        },
      };
    },

    handoff: {
      terraform: {
        type: "github_repository",
        address: "github_repository.this",
        importId: (ctx) => opts.repo(ctx.params),
      },
    },
  };
}
