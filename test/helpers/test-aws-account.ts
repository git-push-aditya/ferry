/**
 * A fake AWS account id used across test fixtures to build fake ARNs
 * (e.g. `arn:aws:iam::<TEST_AWS_ACCOUNT>:role/...`). Never a real account —
 * every test using it runs against fake send() handlers, no network calls.
 * Overridable via the TEST_AWS_ACCOUNT env var; defaults to a fixed value
 * so the suite is deterministic without any env setup.
 */
export const TEST_AWS_ACCOUNT = process.env.TEST_AWS_ACCOUNT ?? "909317186541";
