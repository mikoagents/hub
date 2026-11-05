import assert from "node:assert/strict";
import { it } from "vitest";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { matchPullRequestReadiness, pullRequestComplete } from "./pull-request-gate.js";
import type { PullRequestSnapshot } from "./pull-request-gate.js";

// Protocol-level coverage: no coding model is required to determine routing eligibility.
it("user stops automatic repairs at the configured commit limit without treating findings as passed", async () => {
  // Given settled feedback after three consecutive automation commits.
  const policy = {
    review: { from_user: "reviewer[bot]", body_contains: "protocol" },
    feedback_from: ["reviewer[bot]"],
    required_workflows: ["Coverage"],
    repair_limit: { from_user: "repairer[bot]", max_consecutive_commits: 3 },
    completion_label: {
      name: "passed",
      color: "0E8A16",
      description: "Passed",
      review_body_contains: "clean",
    },
  };
  const event: NormalizedGitHubEvent = {
    id: "review",
    type: "pull_request_review",
    repo: "owner/repo",
    repositoryId: 1,
    installationId: 1,
    createdAt: "2026-11-05T00:00:00Z",
    payload: {
      action: "submitted",
      sender: { login: "reviewer[bot]" },
      pull_request: { number: 1057, head: { sha: "head" } },
      review: { commit_id: "head" },
    },
  };
  const snapshot: PullRequestSnapshot = {
    state: "OPEN",
    isDraft: false,
    sameRepository: true,
    headSha: "head",
    baseSha: "base",
    repairCommitCount: 3,
    reviews: [
      {
        id: 1,
        author: "reviewer[bot]",
        headSha: "head",
        state: "COMMENTED",
        body: "protocol CHANGES REQUESTED",
      },
    ],
    threads: [{ id: "finding", author: "reviewer[bot]", body: "Bug", resolved: false }],
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
  // When review and later CI notifications evaluate the same current head.
  const labels = new Set(["passed"]);
  const evaluate = () =>
    matchPullRequestReadiness(
      event,
      policy,
      async () => snapshot,
      async (_target, _head, label, complete) => {
        if (complete) labels.add(label.name);
        else labels.delete(label.name);
      },
    );
  // Then routing stops before model creation, while unresolved feedback remains unpassed.
  assert.equal(await evaluate(), undefined);
  assert.equal(await evaluate(), undefined);
  assert.equal(pullRequestComplete(snapshot, policy), false);
  assert.deepEqual([...labels], []);

  // Missing commit evidence cannot silently reset the limit; a verified human commit can.
  delete snapshot.repairCommitCount;
  assert.equal(await evaluate(), undefined);
  snapshot.repairCommitCount = 0;
  assert.equal((await evaluate())?.readiness.headSha, "head");

  // Exhaustion does not prevent a genuinely clean final review from completing.
  snapshot.repairCommitCount = 3;
  snapshot.threads = [];
  snapshot.reviews[0]!.body = "protocol clean";
  assert.equal(await evaluate(), undefined);
  assert.deepEqual([...labels], ["passed"]);
});
