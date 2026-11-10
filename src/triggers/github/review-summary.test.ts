import assert from "node:assert/strict";
import { it } from "vitest";
import { pullRequestComplete, readyPullRequestKey } from "./pull-request-gate.js";
import type { PullRequestSnapshot } from "./pull-request-gate.js";

const policy = {
  review: { from_user: "reviewer[bot]", body_contains: "protocol" },
  feedback_from: ["reviewer[bot]"],
  required_workflows: ["Coverage"],
  completion_label: {
    name: "passed",
    color: "0E8A16",
    description: "Passed",
    review_body_contains: "clean result",
  },
};

// Protocol-level cases isolate verdict routing; real transport and persistence are covered
// by completion-label.integration.test.ts and github-readiness.integration.test.ts.
it("user gets completion from the current summary while historical findings stay collapsed", () => {
  // Given a clean current review with older verdicts quoted in its detailed record.
  const snapshot = reviewed(
    "protocol clean result\nAPPROVED\n<details><summary>Details</summary>\n" +
      "Previous: CHANGES REQUESTED and REVIEW INCOMPLETE\n</details>",
  );
  // When routing evaluates the review and all checks are green.
  const repair = readyPullRequestKey(
    { repository: "owner/repo", number: 1058 },
    "head",
    policy,
    snapshot,
  );
  // Then historical evidence neither starts another repair nor blocks completion.
  assert.equal(repair, undefined);
  assert.equal(pullRequestComplete(snapshot, policy), true);
});

it("user cannot receive completion from a clean phrase quoted only in folded evidence", () => {
  // Given unresolved current feedback and a historical clean verdict in the record.
  const snapshot = reviewed(
    "protocol Technical review is still being verified.\n<details><summary>Details</summary>clean result</details>",
  );
  // When the routing policy evaluates the current review.
  const repair = readyPullRequestKey(
    { repository: "owner/repo", number: 1058 },
    "head",
    policy,
    snapshot,
  );
  // Then missing current completion evidence cannot produce a passed label.
  assert.equal(repair, undefined);
  assert.equal(pullRequestComplete(snapshot, policy), false);
});

it("user keeps incomplete current review status even when folded history contains a clean result", () => {
  // Given an incomplete current conclusion with a case-insensitive HTML disclosure.
  const snapshot = reviewed(
    'protocol REVIEW INCOMPLETE\n<DETAILS class="record"><summary>Details</summary>clean result</DETAILS>',
  );
  // When completion is evaluated against the settled checks.
  const complete = pullRequestComplete(snapshot, policy);
  // Then quoting a previous clean result cannot complete the current review.
  assert.equal(complete, false);
});

it("user explicitly enables supplemental verification without replaying historical incomplete verdicts", () => {
  const snapshot = reviewed("protocol REVIEW INCOMPLETE");
  const target = { repository: "owner/repo", number: 1058 };
  assert.equal(readyPullRequestKey(target, "head", policy, snapshot), undefined);
  const enabled = { ...policy, incomplete_review: { body_contains: "REVIEW INCOMPLETE" } };
  assert.equal(typeof readyPullRequestKey(target, "head", enabled, snapshot), "string");
  snapshot.reviews[0]!.body = "protocol clean result\n<details>REVIEW INCOMPLETE</details>";
  assert.equal(readyPullRequestKey(target, "head", enabled, snapshot), undefined);
  assert.equal(pullRequestComplete(snapshot, enabled), true);
});

function reviewed(body: string): PullRequestSnapshot {
  return {
    state: "OPEN",
    isDraft: false,
    sameRepository: true,
    headSha: "head",
    baseSha: "base",
    reviews: [{ id: 1, author: "reviewer[bot]", headSha: "head", state: "COMMENTED", body }],
    threads: [],
    workflows: [
      {
        id: 1,
        workflowId: 1,
        name: "Coverage",
        attempt: 1,
        headSha: "head",
        status: "completed",
        conclusion: "success",
      },
    ],
    checks: [{ status: "completed", conclusion: "success" }],
    statuses: [],
  };
}
