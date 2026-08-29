import type { z } from "zod";
import { defineIntegration } from "../../../src/core/define";
import { runnerScopeLabel } from "../../../src/providers/github";
import { paramsSchema, runnerScope, type Params } from "./params";
import { instanceProfileStep, instanceRoleStep } from "./steps/instance-role";
import { jitConfigStep } from "./steps/jit-config";
import { launchStep } from "./steps/launch";
import { verify } from "./verify";

/**
 * The last unbuilt task from docs/plan/aws-github.md (section 7), and the one
 * EC2 story with Ferry's actual shape: four ordered steps across two
 * providers, where each step's input is the previous step's output, and where
 * a failure halfway leaves a registered-but-dead runner plus an orphaned
 * instance for a human to find.
 */
export default defineIntegration<Params>({
  id: "github/self-hosted-runner-registration",
  schemaVersion: 1,
  summary:
    "Registers a GitHub Actions self-hosted runner via JIT config and launches the EC2 instance that runs it, proven by the runner reporting online.",

  // RUNNER_LABELS/RUNNER_GROUP_ID are coerced from strings and the schema
  // carries a superRefine — Input differs from Output, which z.ZodType<P>
  // cannot model.
  params: paramsSchema as unknown as z.ZodType<Params>,
  credentials: ["aws", "github"],

  /**
   * Ordering is load-bearing at every hop, and rollback unwinds it LIFO:
   *
   *   role     -> profile needs a role to attach
   *   profile  -> the instance needs a profile ARN, not a role ARN
   *   jitconfig-> the UserData script needs the config, so it must exist first
   *   launch   -> consumes both the profile ARN and the JIT config
   *
   * docs/plan/aws-github.md recommends deregistering the runner BEFORE
   * terminating the instance, on the reasoning that the runner id is
   * unrecoverable once the instance is gone. That is true for a human, but
   * not here: the id lives in ctx.outputs, which rollback closures capture
   * and which outlives every step. So the engine's LIFO order (terminate,
   * then deregister) is correct and safe, and deviating from it to match the
   * plan would mean special-casing rollback order in the engine — exactly
   * what the folder-per-integration model exists to avoid.
   */
  steps: [instanceRoleStep, instanceProfileStep, jitConfigStep, launchStep],

  verify,

  reportName: (ctx) => ctx.params.RUNNER_NAME,

  report(ctx) {
    const p = ctx.params;
    const scope = runnerScope(p);

    return `# Self-Hosted Runner — \`${p.RUNNER_NAME}\`

> Generated ${new Date().toISOString()} by \`ferry github/self-hosted-runner-registration\`.
> The JIT config is a live credential and is never written to this report.

## GitHub

- Scope: \`${p.SCOPE}\` (\`${runnerScopeLabel(scope)}\`)
- Runner name: \`${p.RUNNER_NAME}\`
- Runner id: \`${ctx.outputs.runnerId ?? "(already registered before this run)"}\`
- Labels: ${p.RUNNER_LABELS.map((l) => `\`${l}\``).join(", ")}
- Runner group: \`${p.RUNNER_GROUP_ID}\`

## AWS

- Instance: \`${ctx.outputs.instanceId ?? ""}\` (\`${p.INSTANCE_TYPE}\`, AMI \`${p.AMI_ID}\`)
- Availability zone: \`${ctx.outputs.availabilityZone ?? ""}\`
- Private IP: \`${ctx.outputs.privateIp ?? ""}\`
- Instance role: \`${p.IAM_ROLE_NAME}\`
- Instance profile: \`${p.IAM_INSTANCE_PROFILE_NAME}\`

## The role has no permissions

\`${p.IAM_ROLE_NAME}\` was created with an EC2 trust policy and **nothing
attached**. A self-hosted runner executes arbitrary workflow code, so what it
may do in AWS is a decision for whoever operates it — not a default this
integration should pick. Attach a scoped policy with
\`aws/iam/role/create-inline-policy-for-role\`.

## Replacing this runner

A JIT config cannot be reissued for an already-registered runner, so there is
no in-place update. Deregister the runner and re-run.

## Verification

Verified — the instance reports \`running\`, and runner
\`${ctx.outputs.runnerId ?? ""}\` reported \`online\` to GitHub, which proves the
whole chain: profile attached, cloud-init ran, JIT config still valid, agent
reached GitHub.
`;
  },
});
