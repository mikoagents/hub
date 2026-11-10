import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  agentModelSummary,
  hasManualEntry,
  orderSourceFiles,
  eventConfigurationOverview,
  subscriptionListSummary,
  subscriptionSummary,
  triggerTargetSummary,
} from "./presentation.js";
import { inspectTriggerSources } from "./inspection.js";
import { triggerFlowDiagram } from "./flow.js";
import type { TriggerManifest } from "./sdk.js";

const manifest: TriggerManifest = {
  name: "example",
  runner: "local",
  grants: {},
  limits: { maxRuntime: "10m" },
  on: [{ source: "manual", event: "run" }],
};

describe("Trigger presentation", () => {
  it("shows event labels with their connections and schedule timezones in the list", () => {
    assert.deepEqual(subscriptionListSummary(manifest.on), { primary: "Manual run" });
    assert.deepEqual(
      subscriptionListSummary([
        { source: "github", event: "issue_comment_created", connection: "acme-github" },
        { source: "github", event: "pull_request.opened", connection: "acme-github" },
        { source: "inventory", event: "stock.*" },
      ]),
      {
        primary:
          "GitHub issue comment created · GitHub pull request opened · inventory stock events",
        secondary: "acme-github",
      },
    );
    assert.deepEqual(
      subscriptionListSummary([
        {
          source: "schedule",
          event: "tick",
          recurrence: {
            start: "1970-01-01T00:00:00",
            timezone: "Asia/Shanghai",
            rule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=4;BYMINUTE=0;BYSECOND=0",
          },
        },
      ]),
      { primary: "Schedule", secondary: "Every Mon at 04:00 (Asia/Shanghai)" },
    );
  });

  it("summarizes every model without presenting runtime values as a fixed model", () => {
    const inspection = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: `export default {run(ctx) {
        ctx.agent.run("first", {agent:{provider:"codex",model:"gpt-6.1-sol"}});
        ctx.agent.run("repeat", {agent:{provider:"codex",model:"gpt-6.1-sol"}});
        ctx.agent.run("other", {agent:{provider:"claude",model:"opus"}});
        ctx.agent.run("dynamic", {agent:{provider:"codex",model:ctx.event.payload.model}});
      }};`,
      },
    ]);
    assert.equal(
      agentModelSummary(inspection),
      "codex/gpt-6.1-sol · claude/opus · Computed at runtime",
    );
    assert.equal(
      agentModelSummary({ ...inspection, limited: true }),
      "codex/gpt-6.1-sol · claude/opus · Computed at runtime · Defined in code",
    );
    assert.equal(agentModelSummary({ ...inspection, agents: [] }), "Code workflow");
  });

  it("keeps daemon and directory pairs together and identifies runner-only code", () => {
    assert.deepEqual(triggerTargetSummary(manifest), { primary: "Runner: local", path: false });
    const target = { daemon: "macbook-local", cwd: "/workspace/review", providers: ["codex"] };
    assert.deepEqual(
      triggerTargetSummary({
        ...manifest,
        grants: { targets: { review: target, repair: target } },
      }),
      { primary: "macbook-local", secondary: "/workspace/review", path: true },
    );
    assert.deepEqual(
      triggerTargetSummary({
        ...manifest,
        grants: {
          targets: {
            review: target,
            build: { ...target, daemon: "build-server", cwd: "/srv/build" },
          },
        },
      }),
      {
        primary: "2 targets",
        secondary: "macbook-local: /workspace/review · build-server: /srv/build",
        path: false,
      },
    );
  });

  it("offers Run now only when the declared event pattern accepts its actual event", () => {
    assert.equal(hasManualEntry(manifest), true);
    assert.equal(
      hasManualEntry({ ...manifest, on: [{ source: "manual", event: ["other", "r*n"] }] }),
      true,
    );
    assert.equal(
      hasManualEntry({ ...manifest, on: [{ source: "manual", event: "other" }] }),
      false,
    );
    assert.equal(hasManualEntry({ ...manifest, on: [{ source: "github", event: "*" }] }), false);
  });

  it("keeps each subscription's repository on that subscription", () => {
    assert.deepEqual(
      eventConfigurationOverview([
        { source: "github", event: "pull_request.opened", connection: "acme-inc" },
      ]),
      {
        summary: "GitHub · Pull request opened",
        detail: "Connection: acme-inc",
      },
    );
    assert.deepEqual(
      eventConfigurationOverview([
        {
          source: "github",
          event: "pull_request.opened",
          connection: "vioraos-github",
        },
        {
          source: "github",
          event: ["pull_request.ready_for_review", "pull_request.synchronize"],
          connection: "vioraos-github",
          resource: "VioraOS/Viora-Mono",
        },
        {
          source: "github",
          event: ["check_suite.completed", "workflow_run.completed"],
          connection: "vioraos-github",
        },
      ]),
      {
        summary: [
          "Pull request opened",
          "Pull request ready for review, Pull request synchronize · Repository: VioraOS/Viora-Mono",
          "Check suite completed, Workflow run completed",
        ].join("\n"),
        detail: "Connection: vioraos-github",
      },
    );
    assert.deepEqual(
      eventConfigurationOverview([
        {
          source: "github",
          event: "pull_request.opened",
          connection: "acme",
          resource: "acme/app",
        },
        { source: "slack", event: "mention", connection: "acme-slack" },
      ]),
      {
        summary: [
          "GitHub · Pull request opened · acme · Repository: acme/app",
          "Slack · Mention · acme-slack",
        ].join("\n"),
      },
    );
    assert.deepEqual(
      eventConfigurationOverview([
        { source: "github", event: "push", resource: "same" },
        { source: "slack", event: "mention", resource: "same" },
      ]).summary,
      ["GitHub · Push · Repository: same", "Slack · Mention · Resource: same"].join("\n"),
    );
  });

  it("uses readable event and timezone summaries while preserving custom source names", () => {
    assert.equal(subscriptionSummary(manifest.on[0]!), "On demand");
    assert.equal(
      subscriptionSummary({ source: "github", event: "pull_request.opened" }),
      "GitHub · Pull request opened",
    );
    assert.equal(
      subscriptionSummary({ source: "inventory", event: "stock.*" }),
      "inventory · Stock events",
    );
    assert.equal(
      subscriptionSummary({
        source: "schedule",
        event: "tick",
        recurrence: {
          start: "1970-01-01T00:00:00",
          timezone: "Asia/Shanghai",
          rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        },
      }),
      "Every day at 09:00 (Asia/Shanghai)",
    );
  });

  it("lists the declared entrypoint before conventional workflow and supporting files without changing stored order", () => {
    const files = [{ path: "package.json" }, { path: "policy.ts" }, { path: "trigger.ts" }];
    assert.deepEqual(
      orderSourceFiles(files).map((file) => file.path),
      ["trigger.ts", "policy.ts", "package.json"],
    );
    assert.equal(files[0]?.path, "package.json");
    assert.deepEqual(
      orderSourceFiles([...files, { path: "src/main.ts" }], "src/main.ts").map((file) => file.path),
      ["src/main.ts", "trigger.ts", "policy.ts", "package.json"],
    );
  });

  it("documents only known event routing unless the author supplies a workflow diagram", () => {
    const diagram = triggerFlowDiagram(manifest);
    assert.match(diagram, /On demand/u);
    assert.match(diagram, /Result and logs/u);
    assert.match(triggerFlowDiagram(manifest, "TB"), /^flowchart TB/u);
    const authored = "flowchart TD\n check{Ready?} -->|No| check\n check -->|Yes| done[Complete]";
    assert.equal(triggerFlowDiagram({ ...manifest, diagram: authored }), authored);
  });
});
