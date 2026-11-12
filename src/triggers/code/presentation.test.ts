import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  agentModelSummary,
  codeLine,
  eventRecords,
  fixedValues,
  githubAccess,
  hasManualEntry,
  oneOf,
  orderSourceFiles,
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
    const chosen = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: `export default {run(ctx) {
        const fast = ctx.event.source === "manual";
        ctx.agent.run("models", {agent:{provider:"codex",model:fast ? "small" : "large"}});
        ctx.agent.run("pairs", {agent:fast ? {provider:"codex",model:"a"} : {provider:"claude",model:"b"}});
      }};`,
      },
    ]);
    assert.equal(agentModelSummary(chosen), "codex/small · codex/large · Computed at runtime");
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

  it("lists events once per scope and never moves a repository onto another subscription", () => {
    const daily = {
      start: "1970-01-01T00:00:00",
      timezone: "Asia/Shanghai",
      rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    };
    assert.deepEqual(
      eventRecords([
        { source: "manual", event: "run" },
        { source: "github", event: "pull_request.opened", connection: "vioraos-github" },
        {
          source: "github",
          event: ["pull_request.ready_for_review", "pull_request.synchronize"],
          connection: "vioraos-github",
          resource: "VioraOS/Viora-Mono",
        },
        {
          source: "github",
          event: ["check_suite.completed", "pull_request.opened"],
          connection: "vioraos-github",
        },
        { source: "slack", event: "mention", connection: "acme-slack" },
        { source: "schedule", event: "tick", recurrence: daily },
        { source: "inventory", event: "stock.*" },
      ]).map(({ source, primary, secondary }) => [source, primary, secondary]),
      [
        ["manual", "On demand", "When you choose Run now"],
        ["github", "Pull request opened · Check suite completed", "GitHub · via vioraos-github"],
        [
          "github",
          "Pull request ready for review · Pull request synchronize",
          "GitHub · VioraOS/Viora-Mono · via vioraos-github",
        ],
        ["slack", "Mention", "Slack · via acme-slack"],
        ["schedule", "Every day at 09:00 (Asia/Shanghai)", "Schedule"],
        ["inventory", "Stock events", "inventory"],
      ],
    );
  });

  it("groups GitHub grants by connection in name order and says each shared permission once", () => {
    const read = { contents: "read", pull_requests: "read" } as const;
    const write = { contents: "write", pull_requests: "write" } as const;
    assert.deepEqual(
      githubAccess({
        "repository-10": {
          connection: "vioraos-github",
          repositories: ["VioraOS/Viora-Marketing"],
          permissions: write,
        },
        "repository-2": {
          connection: "vioraos-github",
          repositories: ["VioraOS/Viora-Mono"],
          permissions: write,
        },
        other: { connection: "acme-github", repositories: ["acme/app"], permissions: read },
      }),
      [
        {
          connection: "acme-github",
          grants: [{ alias: "other", repositories: ["acme/app"] }],
          permissions: [
            { label: "Contents", shared: "Read", levels: [{ alias: "other", level: "Read" }] },
            {
              label: "Pull requests",
              shared: "Read",
              levels: [{ alias: "other", level: "Read" }],
            },
          ],
        },
        {
          connection: "vioraos-github",
          grants: [
            { alias: "repository-2", repositories: ["VioraOS/Viora-Mono"] },
            { alias: "repository-10", repositories: ["VioraOS/Viora-Marketing"] },
          ],
          permissions: [
            {
              label: "Contents",
              shared: "Write",
              levels: [
                { alias: "repository-2", level: "Write" },
                { alias: "repository-10", level: "Write" },
              ],
            },
            {
              label: "Pull requests",
              shared: "Write",
              levels: [
                { alias: "repository-2", level: "Write" },
                { alias: "repository-10", level: "Write" },
              ],
            },
          ],
        },
      ],
    );
    const [mixed] = githubAccess({
      snapshot: { connection: "acme", repositories: [], permissions: { checks: "read" } },
      review: { connection: "acme", repositories: ["acme/app"], permissions: { issues: "write" } },
    });
    assert.deepEqual(
      mixed?.permissions.map(({ label, shared, levels }) => [label, shared, levels]),
      [
        [
          "Checks",
          null,
          [
            { alias: "review", level: "None" },
            { alias: "snapshot", level: "Read" },
          ],
        ],
        [
          "Issues",
          null,
          [
            { alias: "review", level: "Write" },
            { alias: "snapshot", level: "None" },
          ],
        ],
      ],
    );
  });

  it("reads code settings as their fixed values or the alternatives they pick between", () => {
    const field = { value: null, values: [], expression: null, source: null };
    assert.deepEqual(fixedValues({ ...field, status: "known", value: "max" }), ["max"]);
    assert.deepEqual(fixedValues({ ...field, status: "known" }), []);
    assert.deepEqual(fixedValues({ ...field, status: "unset" }), []);
    assert.deepEqual(fixedValues({ ...field, status: "runtime", expression: "ctx.model" }), []);
    assert.deepEqual(fixedValues({ ...field, status: "choice", values: ["recovery", "review"] }), [
      "recovery",
      "review",
    ]);
    assert.equal(oneOf(["review"]), "review");
    assert.equal(oneOf(["recovery", "review"]), "recovery or review");
    assert.equal(oneOf(["a", "b", "c"]), "a, b, or c");
    assert.equal(
      codeLine("[\n  runtimePrompt,\n  rendered,\n].join()"),
      "[ runtimePrompt, rendered, ].join()",
    );
    assert.equal(codeLine("x".repeat(200)), "x".repeat(119) + "…");
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
