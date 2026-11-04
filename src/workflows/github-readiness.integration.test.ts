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

class GitHubPullRequest {
  state = {
    state: "OPEN",
    isDraft: false,
    headSha: "head",
    baseSha: "base",
    sameRepository: true,
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

async function readinessFixture() {
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
    async deliver(type: "workflow_run" | "pull_request_review", head = "head") {
      const id = randomUUID(),
        receivedAt = new Date();
      const payload = {
        id,
        type,
        repo: "owner/repo",
        repositoryId: 7,
        installationId: 42,
        createdAt: receivedAt.toISOString(),
        payload: {
          action: type === "workflow_run" ? "completed" : "submitted",
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
        source: `github.${type}`,
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
