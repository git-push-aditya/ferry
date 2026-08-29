import { ec2LaunchStep } from "../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * The cloud-init script. Deliberately tiny: it starts a runner binary the AMI
 * already carries, rather than downloading and installing one.
 *
 * That is not a style preference. A JIT config's validity window is
 * meaningfully tighter than the legacy registration token's hour, so every
 * second spent installing on boot is a second the credential is ticking down.
 * An install-on-boot script is the most likely way to make this integration
 * fail intermittently and confusingly. See the README.
 *
 * `--jitconfig` also means no separate `config.sh` step: the runner starts
 * already configured.
 */
function userDataScript(runnerDir: string, runnerUser: string, jitConfig: string): string {
  return `#!/bin/bash
set -euo pipefail

cd ${runnerDir}

# The JIT config is a single-use credential. It is passed on the command line
# rather than written to disk so it does not outlive the process.
sudo -u ${runnerUser} ./run.sh --jitconfig '${jitConfig}'
`;
}

/**
 * Shaped like any other instance launch, with the two fields the former
 * aws/ec2/launch-instance integration never had: UserData and an instance
 * profile ARN. Both were added to the shared `ec2LaunchStep` factory rather
 * than duplicated here, resolving the open design question in
 * docs/plan/aws-github.md section 7.
 *
 * The instance profile ARN is read from ctx.outputs rather than params
 * because the profile is created by an earlier step in this same run.
 */
export const launchStep = ec2LaunchStep<Params>({
  integrationId: "github/self-hosted-runner-registration",
  logicalName: (p) => p.RUNNER_NAME,
  amiId: (p) => p.AMI_ID,
  instanceType: (p) => p.INSTANCE_TYPE,
  subnetId: (p) => p.SUBNET_ID,
  securityGroupIds: (p) => p.SECURITY_GROUP_IDS,
  keyPairName: (p) => p.KEY_PAIR_NAME,
  tags: (p) => ({ "github:runner-name": p.RUNNER_NAME }),

  iamInstanceProfileArn: (ctx) => ctx.outputs.instanceProfileArn as string | undefined,
  userData: (ctx) => {
    const jitConfig = ctx.outputs.runnerJitConfig as string | undefined;
    if (!jitConfig) return undefined;
    return userDataScript(ctx.params.RUNNER_DIR, ctx.params.RUNNER_USER, jitConfig);
  },

  id: "launch-runner-instance",
  title: "Launch the instance that will run the agent",
});
