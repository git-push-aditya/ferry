import { iamInstanceProfileStep, iamRoleStep } from "../../../../src/providers/aws";
import type { Params } from "../params";

/**
 * The trust policy that lets EC2 hand this role's credentials to an instance.
 * Nothing GitHub-specific: EC2 is the principal, because EC2 is what assumes
 * the role on the instance's behalf.
 */
function ec2TrustPolicy() {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
}

/**
 * The role itself carries NO permissions by default, deliberately. What a
 * runner is allowed to do in AWS is a decision for whoever operates it, not
 * a default this integration should pick -- and a self-hosted runner executes
 * arbitrary workflow code, so a generous default here would be a genuinely
 * dangerous thing to ship. Attach policies with
 * aws/iam/role/create-inline-policy-for-role or rotate-role-permissions.
 */
export const instanceRoleStep = iamRoleStep<Params>({
  roleName: (p) => p.IAM_ROLE_NAME,
  trustPolicy: ec2TrustPolicy,
  description: () => "Instance role for a GitHub Actions self-hosted runner (ferry)",
  id: "runner-instance-role",
  title: "Create the runner's instance role",
});

/**
 * EC2 delivers credentials through an instance *profile*, never a bare role.
 * This is the easiest part of the setup to miss, because the AWS console
 * creates the profile implicitly and only ever shows you the role.
 */
export const instanceProfileStep = iamInstanceProfileStep<Params>({
  profileName: (p) => p.IAM_INSTANCE_PROFILE_NAME,
  roleName: (p) => p.IAM_ROLE_NAME,
  id: "runner-instance-profile",
  title: "Create the runner's instance profile",
});
