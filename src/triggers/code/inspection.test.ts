import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { inspectTriggerSources } from "./inspection.js";

describe("Trigger code inspection", () => {
  it("resolves an imported constant used as a shorthand option", () => {
    const result = inspectTriggerSources([
      { path: "policy.ts", content: 'export const agent={provider:"codex",model:"from-import"};' },
      {
        path: "trigger.ts",
        content:
          'import {agent} from "./policy.js";export default defineTrigger({run(ctx){return ctx.agent.run("review",{agent,prompt:"Review"});}});',
      },
    ]);
    assert.equal(result.agents[0]?.provider.value, "codex");
    assert.equal(result.agents[0]?.model.value, "from-import");
    assert.equal(result.agents[0]?.model.source?.path, "policy.ts");
  });
  it("resolves local imports, aliases and property lookups at the call site", () => {
    const result = inspectTriggerSources([
      {
        path: "policy.ts",
        content:
          'export const policy = { agent: { provider:"codex", model:"gpt-example", mode:"auto-review", thinkingOptionId:"max" }, runtime:"50m" } as const;',
      },
      {
        path: "review.ts",
        content: [
          'import { policy as settings } from "./policy.js";',
          "export async function review(ctx) {",
          '  return ctx.agent.run("review", {target:"repository",agent:settings.agent,prompt:ctx.event.payload.body,maxRuntime:settings.runtime,idleTimeout:"10m",github:"review"});',
          "}",
        ].join("\n"),
      },
      {
        path: "trigger.ts",
        content:
          'import {review} from "./review.js"; export default defineTrigger({on:[{source:"manual",event:"run"}],grants:{targets:{repository:{}}},run:review});',
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(result.agents.length, 1);
    assert.equal(agent.provider.value, "codex");
    assert.equal(agent.model.value, "gpt-example");
    assert.equal(agent.mode.value, "auto-review");
    assert.equal(agent.thinking.value, "max");
    assert.equal(agent.maxRuntime.value, "50m");
    assert.equal(agent.model.source?.path, "policy.ts");
    assert.equal(agent.source.path, "review.ts");
    assert.equal(agent.source.line, 3);
    assert.equal(agent.prompt.status, "runtime");
    assert.equal(agent.prompt.value, null);
    assert.equal(result.locations.events?.path, "trigger.ts");
    assert.equal(result.limited, false);
  });

  it("shows the actual call configuration instead of unused recorded production settings", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const original = {agent:{provider:"codex",model:"original-model"}};',
          "export default defineTrigger({run(ctx) {",
          '  return ctx.agent.run("demo",{agent:{provider:"hub-e2e",mode:"default"},target:"test",prompt:"demo"});',
          "}});",
        ].join("\n"),
      },
    ]);
    assert.equal(result.agents[0]?.provider.value, "hub-e2e");
    assert.equal(result.agents[0]?.model.status, "unset");
  });

  it("respects lexical shadowing, mutable bindings and mutated imported objects", () => {
    const result = inspectTriggerSources([
      { path: "policy.ts", content: 'export const agent={provider:"codex",model:"before"};' },
      {
        path: "trigger.ts",
        content: [
          'import {agent} from "./policy.js";',
          'const model="outer";',
          'let mutable="before";',
          "export default defineTrigger({run(ctx,model) {",
          "  agent.model=ctx.event.payload.model;",
          '  return ctx.agent.run("review",{agent:{...agent,model},target:mutable,prompt:"hello"});',
          "}});",
        ].join("\n"),
      },
    ]);
    assert.equal(result.agents[0]?.model.status, "runtime");
    assert.equal(result.agents[0]?.provider.status, "runtime");
    assert.equal(result.agents[0]?.target.status, "runtime");
  });

  it("applies object spread order without guessing runtime overrides", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const base={provider:"codex",mode:"default"};',
          "export default defineTrigger({run(ctx) {",
          '  ctx.agent.run("one",{agent:{...base,...ctx.event.payload},prompt:"one"});',
          '  ctx.agent.run("two",{agent:{...ctx.event.payload,...base},prompt:"two"});',
          "}});",
        ].join("\n"),
      },
    ]);
    assert.equal(result.agents[0]?.provider.status, "runtime");
    assert.equal(result.agents[1]?.provider.value, "codex");
  });

  it("does not execute source, call factories, read external modules or resolve cycles", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'throw new Error("Source must never execute");',
          'import {agent as remote} from "/private/not-a-source-file.js";',
          "const a=b; const b=a;",
          'function factory(){throw new Error("Must not execute");}',
          "export default defineTrigger({run(ctx) {",
          '  ctx.agent.run("factory",factory());',
          '  ctx.agent["run"]("cycle",{agent:a});',
          '  ctx.agent.run("external",{agent:remote});',
          "}});",
        ].join("\n"),
      },
    ]);
    assert.equal(result.agents.length, 3);
    assert(result.agents.every((agent) => agent.provider.status === "runtime"));
  });

  it("bounds large source input and reports incomplete inspection", () => {
    const result = inspectTriggerSources([
      { path: "huge.ts", content: " ".repeat(1024 * 1024 + 1) },
      {
        path: "trigger.ts",
        content:
          'export default defineTrigger({run(ctx){ctx.agent.run("small",{agent:{provider:"codex"}})}});',
      },
    ]);
    assert.equal(result.limited, true);
    assert.equal(result.agents.length, 0);
  });

  it("follows mutations through aliases and never treats a changed object as fixed configuration", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const agent={provider:"codex",model:"before"};',
          "const alias=agent;",
          "export default defineTrigger({run(ctx){alias.model=ctx.event.payload.model;",
          'return ctx.agent.run("review",{agent});}});',
        ].join("\n"),
      },
    ]);
    assert.equal(result.agents[0]?.provider.status, "runtime");
    assert.equal(result.agents[0]?.model.status, "runtime");
  });

  it("uses the authored entrypoint and keeps malformed source from producing asserted values", () => {
    const result = inspectTriggerSources(
      [
        {
          path: "helpers/broken.ts",
          content: 'function broken( { return ctx.agent.run("bad",{agent:{provider:"made-up"}});',
        },
        {
          path: "src/main.ts",
          content:
            'export default defineTrigger({on:[{source:"manual",event:"run"}],run(ctx){return ctx.agent.run("ok",{agent:{provider:"codex"}});}});',
        },
      ],
      "src/main.ts",
    );
    assert.equal(result.limited, true);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]?.provider.value, "codex");
    assert.equal(result.locations.events?.path, "src/main.ts");
  });
});
