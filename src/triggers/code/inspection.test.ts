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
    assert.equal(agent.prompt.expression, "ctx.event.payload.body");
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
    assert.equal(result.agents[0]?.provider.value, "codex");
    assert.equal(result.agents[0]?.model.status, "runtime");
    assert.equal(result.agents[0]?.model.expression, "model");
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

  it("follows mutations through aliases and never treats a changed setting as fixed configuration", () => {
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
    assert.equal(result.agents[0]?.provider.value, "codex");
    assert.equal(result.agents[0]?.model.status, "runtime");
    assert.equal(result.agents[0]?.model.expression, "agent.model");
  });

  it("keeps settings fixed when code only reads or copies the strings beside them", () => {
    const result = inspectTriggerSources([
      {
        path: "policy.ts",
        content: [
          "export const policy = {",
          '  agent: { provider: "codex", model: "gpt-example" },',
          '  permissions: { contents: "write" },',
          '  marker: "<!-- marker -->",',
          '  repositories: ["acme/app"],',
          '  startup: "5m",',
          "} as const;",
        ].join("\n"),
      },
      {
        path: "trigger.ts",
        content: [
          'import { policy } from "./policy.js";',
          "export default defineTrigger({",
          "  grants: { github: { main: { repositories: [...policy.repositories], permissions: { ...policy.permissions } } } },",
          "  run(ctx) {",
          "    if (ctx.event.payload.body.includes(policy.marker)) return;",
          '    ctx.log("agent", { ...policy.agent });',
          "    policy.repositories.forEach((repository) => ctx.log(repository));",
          '    return ctx.agent.run("mention", { agent: policy.agent, startupTimeout: policy.startup, prompt: "hi" });',
          "  },",
          "});",
        ].join("\n"),
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(agent.provider.value, "codex");
    assert.equal(agent.model.value, "gpt-example");
    assert.equal(agent.startupTimeout.value, "5m");
  });

  it("hides only the part of a constant that unread code may change", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const original = { run: { agent: { provider: "codex", model: "m1" }, coordination: { limit: { max: "3m" } } } };',
          "const policy = original.run.coordination;",
          "export default defineTrigger({ run(ctx) {",
          "  withinLimit(ctx, policy.limit);",
          '  return ctx.agent.run("fix", { agent: original.run.agent, maxRuntime: policy.limit.max, prompt: "fix" });',
          "}});",
        ].join("\n"),
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(agent.provider.value, "codex");
    assert.equal(agent.model.value, "m1");
    assert.equal(agent.maxRuntime.status, "runtime");
    assert.equal(agent.maxRuntime.expression, "policy.limit.max");
  });

  it("names a handed-on object's settings where the call reads them", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const agent = { provider: "codex", model: "m" };',
          'const options = { agent, prompt: "p" };',
          "export default defineTrigger({ run(ctx) {",
          "  register(options);",
          '  return ctx.agent.run("x", { agent: options.agent });',
          "}});",
        ].join("\n"),
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(agent.provider.status, "runtime");
    assert.equal(agent.provider.expression, "options.agent.provider");
    assert.equal(agent.provider.source?.line, 5);
  });

  it("follows changes made through loops, callbacks, destructuring and returned aliases", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          "const policy = {",
          '  looped: [{ provider: "codex", model: "a" }],',
          '  called: [{ provider: "codex", model: "b" }],',
          '  destructured: { provider: "codex", model: "c" },',
          '  returned: { provider: "codex", model: "d" },',
          '  assigned: { provider: "codex", model: "e" },',
          "};",
          "const { destructured: alias } = policy;",
          "function pick() { return policy.returned; }",
          "export default defineTrigger({ run(ctx) {",
          "  for (const item of policy.looped) item.model = ctx.event.payload.model;",
          "  policy.called.forEach((item) => { item.model = ctx.event.payload.model; });",
          "  alias.model = ctx.event.payload.model;",
          "  pick().model = ctx.event.payload.model;",
          "  let current; current = policy.assigned; current.model = ctx.event.payload.model;",
          '  ctx.agent.run("looped", { agent: policy.looped[0] });',
          '  ctx.agent.run("called", { agent: policy.called[0] });',
          '  ctx.agent.run("destructured", { agent: policy.destructured });',
          '  ctx.agent.run("returned", { agent: policy.returned });',
          '  ctx.agent.run("assigned", { agent: policy.assigned });',
          "}});",
        ].join("\n"),
      },
    ]);
    assert.equal(result.agents.length, 5);
    for (const agent of result.agents) assert.equal(agent.model.status, "runtime", agent.id.value!);
  });

  it("reads destructured constants and their defaults", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const policy = { agent: { provider: "codex", model: "m" }, limits: { max: "1h" } };',
          'const { agent, limits: { max, idle = "10m" } } = policy;',
          "export default defineTrigger({ run(ctx) {",
          '  return ctx.agent.run("x", { agent, maxRuntime: max, idleTimeout: idle });',
          "}});",
        ].join("\n"),
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(agent.model.value, "m");
    assert.equal(agent.maxRuntime.value, "1h");
    assert.equal(agent.idleTimeout.value, "10m");
  });

  it("shows the values a local function or a condition picks between", () => {
    const result = inspectTriggerSources([
      {
        path: "runtime.ts",
        content: [
          "export function grant(ctx) {",
          '  return ctx.event.source === "manual" ? "recovery" : "review";',
          "}",
          'export const prompt = (ctx) => "Review " + ctx.event.payload.title;',
          "export function partial(ctx) {",
          '  if (ctx.event.payload.draft) return "draft";',
          "}",
        ].join("\n"),
      },
      {
        path: "trigger.ts",
        content: [
          'import { grant, partial, prompt } from "./runtime.js";',
          'const fast = { provider: "codex", model: "small" };',
          'const thorough = { provider: "codex", model: "large" };',
          "export default defineTrigger({ run(ctx) {",
          '  const agent = ctx.event.source === "manual" ? fast : thorough;',
          '  return ctx.agent.run("review", { agent, github: grant(ctx), prompt: prompt(ctx), target: partial(ctx) });',
          "}});",
        ].join("\n"),
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(agent.github.status, "choice");
    assert.deepEqual(agent.github.values, ["recovery", "review"]);
    assert.equal(agent.github.expression, "grant(ctx)");
    assert.equal(agent.github.source?.path, "trigger.ts");
    assert.equal(agent.provider.status, "known");
    assert.equal(agent.provider.value, "codex");
    assert.equal(agent.model.status, "choice");
    assert.deepEqual(agent.model.values, ["small", "large"]);
    assert.equal(agent.prompt.status, "runtime");
    assert.equal(agent.prompt.expression, "prompt(ctx)");
    assert.equal(agent.target.status, "runtime");
  });

  it("applies the defaults code writes beside a setting", () => {
    const result = inspectTriggerSources([
      {
        path: "trigger.ts",
        content: [
          'const policy = { agent: { provider: "codex", mode: "" }, idle: "5m" };',
          "export default defineTrigger({ run(ctx) {",
          '  return ctx.agent.run("x", {',
          '    agent: { provider: policy.agent.provider, mode: policy.agent.mode || "default", model: policy.agent.model ?? "fallback" },',
          '    maxRuntime: policy.max ?? "30m",',
          '    idleTimeout: policy.idle ?? "10m",',
          '    startupTimeout: ctx.event.payload.startup ?? "1m",',
          "  });",
          "}});",
        ].join("\n"),
      },
    ]);
    const agent = result.agents[0]!;
    assert.equal(agent.mode.value, "default");
    assert.equal(agent.model.value, "fallback");
    assert.equal(agent.maxRuntime.value, "30m");
    assert.equal(agent.idleTimeout.value, "5m");
    assert.equal(agent.startupTimeout.status, "runtime");
    assert.equal(agent.startupTimeout.expression, 'ctx.event.payload.startup ?? "1m"');
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
