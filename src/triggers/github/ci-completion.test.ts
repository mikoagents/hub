import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { classifyGitHubEvent } from "./classification.js";
import { matchTriggers } from "./match.js";
import { completedWorkflowRun, githubEventKey } from "./workflow-run.js";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

describe("user starts follow-up work after CI finishes", () => {
  it("user can retry failed CI without replaying the same completed attempt", () => {
    // Given a completed coverage attempt.
    const original = workflowEvent("completed");
    const redelivery = { ...original, id: "another-delivery" };
    const retry = workflowEvent("completed", { run_attempt: 3 });
    // When GitHub redelivers it and later completes a new attempt.
    const keys = [original, redelivery, retry].map(githubEventKey);
    // Then only the genuinely new attempt has a different durable identity.
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
  });

  it("user does not start PR repairs from main-branch CI or malformed payloads", () => {
    // Given a workflow unrelated to a pull request and an invalid workflow ID.
    const push = workflowEvent("completed", { event: "push" });
    const malformed = workflowEvent("completed", { id: "untrusted" });
    // When the webhook classifier receives those events.
    const results = [push, malformed].map(completedWorkflowRun);
    // Then neither event is eligible to start a PR repair.
    assert.deepEqual(results, [undefined, undefined]);
  });
  it("user receives the completed attempt and its pull request without starting on pending CI", () => {
    // Given a pull request whose coverage workflow is running.
    const event = workflowEvent("completed");
    const config = {
      triggers: [
        {
          name: "repair",
          on: "github.workflow_run_completed",
          filters: {
            repo: "VioraOS/Viora-Mono",
            from_users: ["nexmoe"],
          },
        },
      ],
    };
    // When GitHub completes that workflow attempt.
    const classified = classifyGitHubEvent(event);
    const matches = matchTriggers(config, event);
    // Then follow-up work targets that PR, while an in-progress delivery starts nothing.
    assert.equal(classified.semanticEvent, "github.workflow_run_completed");
    assert.equal(classified.item?.number, 1053);
    assert.equal(matches[0]?.trigger.name, "repair");
    assert.deepEqual(matchTriggers(config, workflowEvent("in_progress")), []);
  });
});

function workflowEvent(
  action: string,
  overrides: Record<string, unknown> = {},
): NormalizedGitHubEvent {
  return {
    id: "delivery-coverage",
    type: "workflow_run",
    repo: "VioraOS/Viora-Mono",
    repositoryId: 1062357895,
    installationId: 1,
    createdAt: "2026-11-04T04:20:00Z",
    payload: {
      action,
      sender: { login: "nexmoe" },
      workflow_run: {
        id: 41770361160,
        run_attempt: 2,
        event: "pull_request",
        name: "Coverage",
        status: action === "completed" ? "completed" : "in_progress",
        conclusion: "failure",
        head_sha: "3c33e9d7a1dfba7e60584fc81786d5663ba72fc2",
        pull_requests: [
          { number: 1053, head: { sha: "3c33e9d7a1dfba7e60584fc81786d5663ba72fc2" } },
        ],
        ...overrides,
      },
    },
  };
}
