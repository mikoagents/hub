import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { createMemoryDatabase } from "../../db/memory.js";
import { createActiveProjectConfiguration } from "../../test-utils/project-configuration.js";
import { isAcceptedTriggerProviderMatch } from "../index.js";
import { compileTriggerDocument } from "../configuration/index.js";
import { createGitHubTriggerProvider, type GitHubReactionClient } from "./provider.js";

describe("user receives accurate draft PR review status", () => {
  it("user sees no completion thumbs-up when an existing task skips a draft", async () => {
    // Given a draft accepted before the review trigger gained its draft filter.
    const { provider, project, revision, reactions } = await reviewProvider(false);
    const matches = await provider.match(
      external(project.id, revision.id, pullEvent("opened", true)),
    );
    if (typeof matches === "string" || !isAcceptedTriggerProviderMatch(matches[0])) {
      throw new Error("expected legacy draft task");
    }
    const match = matches[0];
    const accepted = await provider.onDispatchAccepted!(match.triggerContext, match.outputContext);
    assert.deepEqual([...reactions.active.values()], ["eyes"]);
    // When the task detects the draft and finishes without publishing a review.
    await provider.onAgentExecutionCompleted!(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded" },
      accepted ?? null,
    );
    // Then the progress reaction disappears without implying a completed review.
    assert.deepEqual([...reactions.active.values()], []);
  });

  it.each(["opened", "synchronize"])(
    "user starts no review task for a draft PR on %s",
    async (action) => {
      // Given a review trigger configured to accept only ready PRs.
      const { provider, project, revision, reactions } = await reviewProvider(true);
      // When GitHub creates or updates a draft PR.
      const result = await provider.match(
        external(project.id, revision.id, pullEvent(action, true)),
      );
      // Then routing stops before an agent or progress/completion reaction is created.
      assert.equal(result, "trigger_filters_rejected");
      assert.deepEqual([...reactions.active.values()], []);
    },
  );

  it("user can start a review by marking the skipped draft ready", async () => {
    // Given a draft excluded by its review trigger.
    const { provider, project, revision, reactions } = await reviewProvider(true);
    assert.equal(
      await provider.match(external(project.id, revision.id, pullEvent("opened", true))),
      "trigger_filters_rejected",
    );
    // When the same PR becomes ready and its review task completes.
    const matches = await provider.match(
      external(project.id, revision.id, pullEvent("ready_for_review", false)),
    );
    if (typeof matches === "string" || !isAcceptedTriggerProviderMatch(matches[0])) {
      throw new Error("expected ready review task");
    }
    const match = matches[0];
    const accepted = await provider.onDispatchAccepted!(match.triggerContext, match.outputContext);
    await provider.onAgentExecutionCompleted!(
      match.triggerContext,
      match.outputContext,
      { status: "succeeded" },
      accepted ?? null,
    );
    // Then the ready event is accepted and receives the ordinary completion reaction.
    assert.equal(match.triggerContext.event.github.item?.number, 1060);
    assert.deepEqual([...reactions.active.values()], ["+1"]);
  });

  it("user does not route an unknown draft status as a ready PR", async () => {
    // Given an event without a reliable draft flag and a ready-only review trigger.
    const { provider, project, revision } = await reviewProvider(true);
    const event = pullEvent("opened", undefined);
    // When the event reaches review routing.
    const result = await provider.match(external(project.id, revision.id, event));
    // Then an incomplete event cannot bypass the draft requirement.
    assert.equal(result, "trigger_filters_rejected");
  });
});

async function reviewProvider(filterDrafts: boolean) {
  const compiled = compileTriggerDocument(`
name: review
on:
  github.pull_request_created:
    filters: { from_users: ['*']${filterDrafts ? ", draft: false" : ""} }
  github.pull_request_synchronized:
    filters: { from_users: ['*']${filterDrafts ? ", draft: false" : ""} }
  github.pull_request_ready_for_review:
    filters: { from_users: ['*']${filterDrafts ? ", draft: false" : ""} }
run:
  target: { daemon: devbox, cwd: /repo }
  agent: { provider: codex, mode: auto-review }
  prompt: Review this PR.
`);
  const configuration = await createActiveProjectConfiguration(createMemoryDatabase(), {
    environments: [compiled.environment],
    triggers: Object.entries(compiled.authored.on).map(([on, definition], index) => ({
      name: `review-${index}`,
      on,
      filters: definition.filters,
      max_runtime: "1h",
      steps: [
        {
          id: "run",
          environment: "target",
          max_runtime: "1h",
          idle_timeout: "10m",
          agent: { provider: "codex", mode: "auto-review" },
          prompt: [{ text: "Review this PR." }],
        },
      ],
    })),
  });
  const reactions = new ActiveReactions();
  const provider = createGitHubTriggerProvider({
    configurationStoreForProject: () => configuration.store,
    reactions,
  });
  return { ...configuration, provider, reactions };
}

// External reaction state exercises creation/removal semantics; it is not a call log.
class ActiveReactions implements GitHubReactionClient {
  readonly active = new Map<number, string>();
  private nextId = 1;

  async createReaction(input: Parameters<GitHubReactionClient["createReaction"]>[0]) {
    const id = this.nextId++;
    this.active.set(id, input.content);
    return { id };
  }

  async deleteReaction(input: Parameters<GitHubReactionClient["deleteReaction"]>[0]) {
    this.active.delete(input.reactionId);
  }
}

function external(
  projectId: string,
  configurationRevisionId: string,
  payload: NormalizedGitHubEvent,
) {
  return {
    providerEventReceiptId: "11111111-1111-4111-8111-111111111119",
    organizationId: "org_1",
    projectId,
    configurationRevisionId,
    source: "github.pull_request",
    deliveryId: payload.id,
    receivedAt: new Date(),
    payload,
  };
}

function pullEvent(action: string, draft: boolean | undefined): NormalizedGitHubEvent {
  return {
    id: `draft-review-${action}`,
    type: "pull_request",
    repo: "VioraOS/Viora-Mono",
    repositoryId: 1062357895,
    installationId: 42,
    createdAt: "2026-11-06T09:37:44Z",
    payload: {
      action,
      sender: { login: "nexmoe" },
      pull_request: {
        number: 1060,
        draft,
        title: "Native device tools",
        body: "Review device tools",
        head: { sha: "245357b0978f28c18d2459e8255b4ea228fad754" },
      },
    },
  };
}
