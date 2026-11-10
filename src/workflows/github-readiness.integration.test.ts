import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { embeddedDatabaseRuntime } from "../db/runtime/index.js";
import { createDatabase } from "../db/pg.js";
import { ProjectConfigurationStore } from "../configuration/store.js";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { createGitHubTriggerProvider } from "../triggers/github/provider.js";
import type { PullRequestSnapshot } from "../triggers/github/pull-request-gate.js";
import { composeEntitlements } from "../auth/entitlements.js";
import { hashTemplate, UNLIMITED_TEMPLATE } from "../entitlements/catalog.js";
import { DurableWorkflowEngine } from "./engine.js";
import { durableExecutionId } from "../daemons/lifecycle.js";

// API-to-persistence acceptance: scheduling, migrations and metering use real PGlite.
// GitHub and Paseo are external boundaries; no paid coding model is launched by this suite.
it("user starts one repair for settled feedback across review and CI events, including after restart", async () => {
  // Given an open PR whose trusted review and independent workflows arrive separately.
  const fixture = await readinessFixture();
  try {
    await fixture.deliver("workflow_run");
    assert.equal(await fixture.executions(), 0);
    fixture.remote.review();
    await fixture.deliver("pull_request_review");
    assert.equal(await fixture.executions(), 0);
    fixture.remote.finish("Repository Checks", "success");
    fixture.remote.finish("Coverage", "failure");
    fixture.remote.state.workflows[1]!.status = "in_progress";
    fixture.remote.state.workflows[1]!.conclusion = null;
    await fixture.deliver("workflow_run");
    assert.equal(await fixture.executions(), 0);
    fixture.remote.finish("Coverage", "failure");
    fixture.remote.finish("Repository Checks", "success");
    // When completed workflows and review redeliveries carry the same repair evidence.
    await fixture.deliver("pull_request_review");
    await fixture.deliver("pull_request_review");
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    // Then exactly one model execution exists and survives a real database reopen.
    assert.equal(await fixture.executions(), 1);
    const usage = await fixture.runtime.query(
      "select used from organization_usage where meter = 'executions.monthly'",
    );
    assert.equal(Number(usage.rows[0]?.["used"]), 1);
    await fixture.complete();
    await fixture.restart();
    await fixture.deliver("workflow_run");
    await fixture.deliver("pull_request_review");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 1);
    assert.equal(await fixture.runs(), 1);

    // A late successful, unrelated workflow carries no new repair evidence.
    fixture.remote.finish("Help CI", "success");
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 1);

    // New failed CI attempts remain actionable rather than being suppressed by head alone.
    fixture.remote.finish("Coverage", "failure", 2);
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 2);
    await fixture.complete();

    // Genuinely new trusted feedback on that head also wakes once.
    fixture.remote.finding("late-codex");
    await fixture.deliver("pull_request_review");
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 3);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user spends no model tokens on clean, stale, closed, draft or incomplete pull requests", async () => {
  // Given a completed clean review and green mandatory workflows.
  const fixture = await readinessFixture();
  try {
    fixture.remote.review();
    fixture.remote.finish("Coverage", "success");
    fixture.remote.finish("Repository Checks", "success");
    // When GitHub emits completion events for clean and ineligible PR states.
    await fixture.deliver("workflow_run");
    fixture.remote.finding("issue");
    fixture.remote.state.isDraft = true;
    await fixture.deliver("pull_request_review");
    fixture.remote.state.isDraft = false;
    fixture.remote.state.state = "CLOSED";
    await fixture.deliver("workflow_run");
    fixture.remote.state.state = "OPEN";
    await fixture.deliver("workflow_run", "old-head");
    fixture.remote.state.reviews = [];
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    // Then none of those events creates an accepted repair or an execution.
    assert.equal(await fixture.runs(), 0);
    assert.equal(await fixture.executions(), 0);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user resumes unfinished verification once after CI settles without looping on follow-up reviews", async () => {
  const fixture = await readinessFixture(true, false, true);
  try {
    // Given an explicitly enabled follow-up for a submitted but unfinished review.
    fixture.remote.review();
    fixture.remote.state.reviews[0]!.body += " REVIEW INCOMPLETE";
    fixture.remote.finish("Repository Checks", "success");
    await fixture.deliver("pull_request_review");
    assert.equal(await fixture.executions(), 0);

    // When the independent CI evidence arrives, duplicate sources start one bounded workflow.
    fixture.remote.finish("Coverage", "success");
    await fixture.deliver("workflow_run");
    await fixture.deliver("pull_request_review");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 1);
    assert(!fixture.remote.labels.has("ai-complete"));
    await fixture.complete();
    await fixture.restart();

    // Another incomplete receipt and unrelated green CI cannot restart that head's work.
    fixture.remote.state.reviews[0]!.id += 1;
    fixture.remote.state.reviews[0]!.body += "\nVerification still missing.";
    fixture.remote.finish("Help CI", "success");
    await fixture.deliver("pull_request_review");
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 1);
    assert.equal(await fixture.runs(), 1);

    // Only a verified clean review closes the existing completion gate.
    fixture.remote.state.reviews[0]!.body = "review protocol clean result";
    await fixture.deliver("pull_request_review");
    assert(fixture.remote.labels.has("ai-complete"));
    assert.equal(await fixture.executions(), 1);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user skips queued repairs before model creation when their head becomes obsolete", async () => {
  // Given ready repair input accepted before the worker dispatches it.
  const fixture = await readinessFixture();
  try {
    fixture.remote.review();
    fixture.remote.finding("issue");
    fixture.remote.finish("Coverage", "success");
    fixture.remote.finish("Repository Checks", "success");
    await fixture.deliver("workflow_run");
    // When a human pushes a different head before dispatch.
    fixture.remote.state.headSha = "new-head";
    await fixture.engine.processAvailable();
    // Then the pending repair is skipped without creating an agent execution.
    assert.equal(await fixture.executions(), 0);
    const steps = await fixture.runtime.query("select status from workflow_step_runs");
    assert.deepEqual(steps.rows, [{ status: "skipped" }]);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user sees a completion label only after clean review, resolved feedback and green CI without model work", async () => {
  // Given explicit label authority and a clean technical review with a separate human decision.
  const fixture = await readinessFixture(true);
  try {
    fixture.remote.review();
    fixture.remote.state.reviews[0]!.body += " clean result\nMAINTAINER DECISION REQUIRED";
    fixture.remote.finish("Repository Checks", "success");
    await fixture.deliver("pull_request_review");
    assert.deepEqual([...fixture.remote.labels], ["needs-human-review"]);
    // When the last workflow settles, independently from the review event.
    fixture.remote.finish("Coverage", "success");
    await fixture.deliver("workflow_run");
    assert.deepEqual([...fixture.remote.labels], ["needs-human-review", "ai-complete"]);
    await fixture.deliver("pull_request_review");
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    // Then duplicate completion notifications require no workflow run or AI execution.
    assert.equal(await fixture.runs(), 0);
    assert.equal(await fixture.executions(), 0);
    // A stale event does not clear the current head's completion.
    await fixture.deliver("workflow_run", "old-head");
    assert(fixture.remote.labels.has("ai-complete"));
    // A new head invalidates it before that head has any review or CI.
    fixture.remote.state.headSha = "new-head";
    await fixture.deliver("pull_request_synchronized", "new-head");
    assert.deepEqual([...fixture.remote.labels], ["needs-human-review"]);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user stops a repair chain before another execution or charge and resumes after a human commit", async () => {
  // Given three automation commits with a confirmed unresolved finding and green CI.
  const fixture = await readinessFixture(true, true);
  try {
    fixture.remote.state.repairCommitCount = 3;
    fixture.remote.review();
    fixture.remote.finding("remaining");
    fixture.remote.finish("Coverage", "success");
    fixture.remote.finish("Repository Checks", "success");
    // When GitHub delivers reviews and new failed CI attempts, even across a restart.
    await fixture.deliver("pull_request_review");
    await fixture.restart();
    fixture.remote.finish("Coverage", "failure", 2);
    await fixture.deliver("workflow_run");
    await fixture.engine.processAvailable();
    // Then no model work or usage is created and the finding is not marked passed.
    assert.equal(await fixture.runs(), 0);
    assert.equal(await fixture.executions(), 0);
    const usage = await fixture.runtime.query("select used from organization_usage");
    assert.deepEqual(usage.rows, []);
    assert.deepEqual([...fixture.remote.labels], ["needs-human-review"]);
    assert.equal(fixture.remote.state.threads[0]!.resolved, false);

    // A human-authored head resets the verified contiguous automation chain.
    fixture.remote.state.headSha = "human-head";
    fixture.remote.state.repairCommitCount = 0;
    fixture.remote.review();
    fixture.remote.finish("Coverage", "success");
    fixture.remote.finish("Repository Checks", "success");
    await fixture.deliver("pull_request_review", "human-head");
    await fixture.engine.processAvailable();
    assert.equal(await fixture.executions(), 1);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user rechecks the repair limit before dispatching accepted work", async () => {
  // Given repair input that was accepted while below the configured limit.
  const fixture = await readinessFixture(false, true);
  try {
    fixture.remote.review();
    fixture.remote.finding("remaining");
    fixture.remote.finish("Coverage", "success");
    fixture.remote.finish("Repository Checks", "success");
    await fixture.deliver("pull_request_review");
    // When the final remote commit attribution is unavailable before dispatch.
    delete fixture.remote.state.repairCommitCount;
    await fixture.engine.processAvailable();
    // Then Hub fails closed without a model execution or execution meter charge.
    assert.equal(await fixture.executions(), 0);
    const steps = await fixture.runtime.query("select status from workflow_step_runs");
    assert.deepEqual(steps.rows, [{ status: "skipped" }]);
  } finally {
    await fixture.close();
  }
}, 60_000);

it("user never retains completion after new feedback, failed checks or incomplete review", async () => {
  const fixture = await readinessFixture(true);
  try {
    fixture.remote.review();
    fixture.remote.state.reviews[0]!.body += " clean result";
    fixture.remote.finish("Repository Checks", "success");
    fixture.remote.finish("Coverage", "success");
    await fixture.deliver("workflow_run");
    assert(fixture.remote.labels.has("ai-complete"));
    fixture.remote.finding("new");
    await fixture.deliver("pull_request_review");
    assert(!fixture.remote.labels.has("ai-complete"));
    fixture.remote.state.threads[0]!.resolved = true;
    fixture.remote.state.checks[0]!.conclusion = "failure";
    await fixture.deliver("workflow_run");
    assert(!fixture.remote.labels.has("ai-complete"));
    fixture.remote.state.checks[0]!.conclusion = "success";
    fixture.remote.state.statuses.push({ state: "pending" });
    await fixture.deliver("workflow_run");
    assert(!fixture.remote.labels.has("ai-complete"));
    fixture.remote.state.statuses = [];
    fixture.remote.state.reviews[0]!.body += " REVIEW INCOMPLETE";
    await fixture.deliver("pull_request_review");
    assert(!fixture.remote.labels.has("ai-complete"));
    fixture.remote.state.reviews[0]!.body = "review protocol clean result";
    await fixture.deliver("pull_request_review");
    assert(fixture.remote.labels.has("ai-complete"));
    fixture.remote.finish("Coverage", "failure", 2);
    await fixture.deliver("workflow_run");
    assert(!fixture.remote.labels.has("ai-complete"));
  } finally {
    await fixture.close();
  }
}, 60_000);

class GitHubPullRequest {
  labels = new Set(["needs-human-review"]);
  state: PullRequestSnapshot & Required<Pick<PullRequestSnapshot, "checks" | "statuses">> = {
    state: "OPEN",
    isDraft: false,
    headSha: "head",
    baseSha: "base",
    sameRepository: true,
    repairCommitCount: 0,
    checks: [{ status: "completed", conclusion: "success" as string | null }],
    statuses: [] as { state: string }[],
    reviews: [] as { id: number; author: string; headSha: string; state: string; body: string }[],
    threads: [] as { id: string; author: string; body: string; resolved: boolean }[],
    workflows: [] as {
      id: number;
      workflowId: number;
      name: string;
      attempt: number;
      headSha: string;
      status: string;
      conclusion: string | null;
    }[],
  };
  review() {
    this.state.reviews.push({
      id: 7,
      author: "reviewer[bot]",
      headSha: this.state.headSha,
      state: "COMMENTED",
      body: "review protocol",
    });
  }
  finding(id: string) {
    this.state.threads.push({ id, author: "codex[bot]", body: `Finding ${id}`, resolved: false });
  }
  finish(name: string, conclusion: string, attempt = 1) {
    const existing = this.state.workflows.find((x) => x.name === name);
    const run = {
      id: existing?.id ?? this.state.workflows.length + 1,
      workflowId: existing?.workflowId ?? this.state.workflows.length + 1,
      name,
      attempt,
      headSha: this.state.headSha,
      status: "completed",
      conclusion,
    };
    this.state.workflows = this.state.workflows.filter((x) => x.name !== name).concat(run);
  }
  async read() {
    return structuredClone(this.state);
  }
}

async function readinessFixture(
  withCompletionLabel = false,
  withRepairLimit = false,
  withIncompleteReview = false,
) {
  const root = await mkdtemp(join(tmpdir(), "hub-readiness-"));
  let bundle = await embeddedDatabaseRuntime(root);
  await bundle.runtime.migrate();
  let database = createDatabase(bundle.runtime, bundle.locks);
  let entitlements = composeEntitlements(database, bundle.runtime);
  const remote = new GitHubPullRequest();
  await bundle.runtime.query(
    "insert into organization (id,name,slug) values ('ready-org','Ready','ready')",
  );
  const project = await database.createProject({
    organizationId: "ready-org",
    name: "Repair",
    slug: "repair",
    createdByUserId: null,
  });
  await database.stampOrganizationEntitlements({
    organizationId: "ready-org",
    granted: UNLIMITED_TEMPLATE,
    planId: null,
    planVersion: hashTemplate(UNLIMITED_TEMPLATE),
    source: "provisioning",
    actor: null,
    reason: null,
  });
  const compiled = compileTriggerDocument(`
name: repair
on:
  github.pull_request_review:
    filters: {from_users: ['*']}
  github.workflow_run_completed:
    filters: {from_users: ['*']}
  github.pull_request_synchronized:
    filters: {from_users: ['*']}
run:
  target: {daemon: test, cwd: /tmp}
  agent: {provider: codex}
  coordination:
    serialize: conversation
    deduplicate: provider_state
    github_pull_request:
      review: {from_user: 'reviewer[bot]', body_contains: 'review protocol'}
      feedback_from: ['reviewer[bot]', 'codex[bot]']
      required_workflows: [Coverage, Repository Checks]
${withIncompleteReview ? "      incomplete_review: {body_contains: 'REVIEW INCOMPLETE'}" : ""}
${withRepairLimit ? "      repair_limit: {from_user: 'repairer[bot]', max_consecutive_commits: 3}" : ""}
${withCompletionLabel ? "      completion_label: {name: ai-complete, color: '0E8A16', description: AI complete, review_body_contains: 'clean result'}" : ""}
  prompt: Repair
`);
  const config = {
    environments: [{ ...compiled.environment, daemonId: randomUUID() }],
    triggers: compiled.events,
  };
  const revision = await database.insertProjectConfigurationRevision({
    projectId: project.id,
    sourceKind: "manual",
    sourceEvidence: {},
    normalizedConfiguration: config,
    contentHash: "ready",
  });
  await database.activateProjectConfigurationRevision(project.id, revision.id);
  const makeEngine = () =>
    new DurableWorkflowEngine({
      database,
      entitlements: entitlements.service,
      providers: [
        createGitHubTriggerProvider({
          configurationStoreForProject: () => new ProjectConfigurationStore(database, project.id),
          reactions: { createReaction: async () => null, deleteReaction: async () => undefined },
          readPullRequest: () => remote.read(),
          async syncCompletionLabel(_target, head, label, complete) {
            if (remote.state.headSha !== head) return;
            if (complete) remote.labels.add(label.name);
            else remote.labels.delete(label.name);
          },
        }),
      ],
      async dispatchLaunchMachineIntent(intent) {
        return database.transitionAgentExecution(durableExecutionId(intent), "running");
      },
    });
  let engine = makeEngine();
  return {
    remote,
    get runtime() {
      return bundle.runtime;
    },
    get engine() {
      return engine;
    },
    async deliver(
      type: "workflow_run" | "pull_request_review" | "pull_request_synchronized",
      head = "head",
    ) {
      const id = randomUUID(),
        receivedAt = new Date();
      const payload = {
        id,
        type: type === "pull_request_synchronized" ? "pull_request" : type,
        repo: "owner/repo",
        repositoryId: 7,
        installationId: 42,
        createdAt: receivedAt.toISOString(),
        payload: {
          action: {
            workflow_run: "completed",
            pull_request_review: "submitted",
            pull_request_synchronized: "synchronize",
          }[type],
          sender: { login: "reviewer[bot]" },
          pull_request: { number: 1053, head: { sha: head } },
          review: {
            id: 7,
            body: "review protocol",
            state: "commented",
            commit_id: head,
            user: { login: "reviewer[bot]" },
          },
          workflow_run: {
            id: 123,
            run_attempt: 1,
            event: "pull_request",
            status: "completed",
            conclusion: "failure",
            head_sha: head,
            pull_requests: [{ number: 1053 }],
          },
        },
      };
      const receipt = await database.persistManualEvent({
        organizationId: "ready-org",
        projectId: project.id,
        deliveryId: id,
        source: type === "pull_request_synchronized" ? "github.pull_request" : `github.${type}`,
        payload,
        receivedAt,
      });
      if (receipt.status !== "accepted") throw new Error("receipt rejected");
      await engine.enqueue(receipt.event);
    },
    async executions() {
      return Number(
        (await bundle.runtime.query("select count(*) as count from agent_executions")).rows[0]?.[
          "count"
        ],
      );
    },
    async runs() {
      return Number(
        (await bundle.runtime.query("select count(*) as count from trigger_runs")).rows[0]?.[
          "count"
        ],
      );
    },
    async complete() {
      const rows = await bundle.runtime.query<{ id: string }>(
        "select id from agent_executions where status='running'",
      );
      for (const row of rows.rows) {
        await database.transitionAgentExecution(row.id, "succeeded");
        await bundle.runtime.query(
          "update agent_executions set hub_action=null,hub_action_completed_at=now() where id=$1",
          [row.id],
        );
      }
      await engine.processAvailable();
    },
    async restart() {
      await engine.stop();
      await entitlements.close();
      await database.close();
      bundle = await embeddedDatabaseRuntime(root);
      database = createDatabase(bundle.runtime, bundle.locks);
      entitlements = composeEntitlements(database, bundle.runtime);
      engine = makeEngine();
    },
    async close() {
      await engine.stop();
      await entitlements.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
