import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HubHarness } from "../daemons/test-utils/hub-harness.js";

// API acceptance through real PostgreSQL, the production workflow engine and MCP server.
// The harness implements the external Paseo transport; no paid coding model is launched.
describe("user resumes unfinished repairs through the persisted Hub workflow", () => {
  let hub: HubHarness;
  beforeEach(async () => {
    hub = await HubHarness.start();
    await hub.connectDaemon();
    const response = await fetch(`${hub.originUrl()}/api/v1/triggers/install`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer paseo_pk_hub-harness_test",
      },
      body: JSON.stringify({ yaml: document(hub.connectedDaemonSlug()) }),
    });
    assert.equal(response.status, 201, await response.text());
  }, 120_000);
  afterEach(async () => {
    await hub.stop();
  }, 120_000);

  it("user continues from a checkpoint after restart without accepting the event twice", async () => {
    // Given a repair whose first segment has not completed the requested work.
    const started = await hub.runManual({
      trigger: "repair",
      deliveryKey: "repair-original-input",
    });
    assert.equal(started.status, 200);
    await hub.waitForCreatedAgentRequests(1);
    const first = await hub.waitForPendingExecution();
    const checkpoint = "candidate tree abc; coverage 65%; finish photo cancellation scenarios";
    // When the agent yields and Hub restarts before the whole repair is complete.
    const yielded = await hub.callSessionTool(first.id, "finish_execution", {
      output: { outcome: "continue", checkpoint },
    });
    assert.equal(toolFailed(yielded), false);
    assert.equal((await hub.workflowExecutionState(first.id)).runStatus, "running");
    await hub.restartApp();
    const duplicate = await hub.runManual({
      trigger: "repair",
      deliveryKey: "repair-original-input",
    });
    await hub.waitForCreatedAgentRequests(2);
    const second = await hub.waitForPendingExecution();
    // Then the same claimed run resumes with its evidence and a fresh capability credential.
    assert.equal(duplicate.triggerRunId, started.triggerRunId);
    assert.notEqual(second.id, first.id);
    assert.notEqual(second.completionTokenHash, first.completionTokenHash);
    assert.deepEqual(second.launchIntent?.iteration, { index: 2, limit: 3 });
    assert.equal(second.launchIntent?.prompt.includes(checkpoint), true);
    await hub.callSessionTool(second.id, "finish_execution", {
      output: {
        outcome: "complete",
        checkpoint: "pushed verified fix; resolved corresponding threads",
      },
    });
    await expect
      .poll(async () => (await hub.workflowExecutionState(second.id)).runStatus)
      .toBe("succeeded");
    assert.equal(await hub.pendingExecutionCount(), 0);
  });

  it("user sees an actual permission blocker as a failed repair rather than a successful completion", async () => {
    // Given an iterative repair with an active agent execution.
    await hub.runManual({ trigger: "repair", deliveryKey: "repair-permission" });
    await hub.waitForDeliveredPrompts(1);
    const execution = await hub.waitForPendingExecution();
    assert.ok(execution.daemonAgentId);
    await hub.startExecution(execution.daemonAgentId);
    await hub.waitForExecutionStatus(execution.id, "running");
    // When coverage is offered as a blocker and then a real external permission loss is reported.
    const invalid = await hub.callSessionTool(execution.id, "finish_execution", {
      output: {
        outcome: "blocked",
        checkpoint: "saved candidate",
        blocker: { kind: "coverage", reason: "below threshold" },
      },
    });
    assert.equal(toolFailed(invalid), true);
    assert.equal((await hub.execution(execution.id)).status, "running");
    const blocked = await hub.callSessionTool(execution.id, "finish_execution", {
      output: {
        outcome: "blocked",
        checkpoint: "saved candidate",
        blocker: { kind: "permission", reason: "GitHub App write access revoked" },
      },
    });
    // Then the callback succeeds, but both execution and workflow retain a failure with its cause.
    assert.equal(toolFailed(blocked), false);
    const state = await hub.workflowExecutionState(execution.id);
    assert.equal(state.executionStatus, "failed");
    assert.equal(state.runStatus, "failed");
    assert.equal(state.runFailure, "external_blocker:permission: GitHub App write access revoked");
    assert.equal(await hub.pendingExecutionCount(), 0);
  });
});

function toolFailed(response: Record<string, unknown>): boolean {
  const result = response["result"];
  if (typeof result !== "object" || result === null) throw new Error("Missing MCP tool result");
  return Reflect.get(result, "isError") === true;
}

function document(daemon: string): string {
  return `
name: repair
max_runtime: 4h
on:
  manual.run: {}
run:
  iterations: { max_runs: 3 }
  continuation: { mode: new }
  target: { daemon: ${daemon}, cwd: /workspace/repair }
  agent: { provider: codex, mode: full-access }
  max_runtime: 50m
  prompt: Repair coverage and retain exact candidate evidence.
`;
}
