import { describe, expect, test } from "bun:test";
import { branchProtectionMatches, type DesiredBranchProtection, type LiveBranchProtection } from "../../src/providers/github/branch-protection";

const DESIRED: DesiredBranchProtection = {
  required_status_checks: { strict: true, contexts: ["ci/build"] },
  required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 2 },
  enforce_admins: true,
  restrictions: null,
};

describe("branchProtectionMatches", () => {
  test("normalizes enforce_admins' GET/PUT shape asymmetry", () => {
    const live: LiveBranchProtection = {
      required_status_checks: { strict: true, contexts: ["ci/build"] },
      required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 2 },
      enforce_admins: { enabled: true }, // GET wraps it; PUT wants a bare boolean
      restrictions: null,
    };
    expect(branchProtectionMatches(live, DESIRED)).toBe(true);
  });

  test("enforce_admins mismatch (wrapped false vs. desired true) is detected", () => {
    const live: LiveBranchProtection = { ...DESIRED, enforce_admins: { enabled: false } };
    expect(branchProtectionMatches(live, DESIRED)).toBe(false);
  });

  test("missing enforce_admins on the live document defaults to false", () => {
    const live: LiveBranchProtection = { ...DESIRED, enforce_admins: undefined };
    expect(branchProtectionMatches(live, { ...DESIRED, enforce_admins: false })).toBe(true);
    expect(branchProtectionMatches(live, DESIRED)).toBe(false); // desired is true
  });

  test("field order does not matter (stable-stringify compare)", () => {
    const live: LiveBranchProtection = {
      enforce_admins: { enabled: true },
      restrictions: null,
      required_pull_request_reviews: { required_approving_review_count: 2, dismiss_stale_reviews: true },
      required_status_checks: { contexts: ["ci/build"], strict: true },
    };
    expect(branchProtectionMatches(live, DESIRED)).toBe(true);
  });

  test("a genuine content difference (extra context) is detected", () => {
    const live: LiveBranchProtection = {
      ...DESIRED,
      enforce_admins: { enabled: true },
      required_status_checks: { strict: true, contexts: ["ci/build", "ci/test"] },
    };
    expect(branchProtectionMatches(live, DESIRED)).toBe(false);
  });
});
