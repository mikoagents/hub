import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { parseInvocation } from "./invocation.js";

const inputs = {
  repo: { type: "string" as const, choices: ["paseo", "hub"] },
  agent: { type: "string" as const, default: "codex", choices: ["codex", "opus"] },
  count: { type: "number" as const },
};

const requiredInputs = {
  ...inputs,
  dry: { type: "boolean" as const, required: true },
};

describe("provider-neutral message invocation parser", () => {
  it.each([
    {
      name: "parses after the mention without changing the prompt",
      message: "  @Miko   repo=hub investigate",
      mention: "@Miko",
      expected: {
        prompt: "  @Miko   repo=hub investigate",
        inputs: { repo: "hub", agent: "codex" },
      },
    },
    {
      name: "accepts zero inputs",
      message: "investigate the failed sync",
      expected: {
        prompt: "investigate the failed sync",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "accepts multiple consecutive inputs",
      message: "repo=hub agent=opus investigate",
      expected: {
        prompt: "repo=hub agent=opus investigate",
        inputs: { repo: "hub", agent: "opus" },
      },
    },
    {
      name: "preserves whitespace in the prompt remainder",
      message: "repo=hub   investigate   the sync  ",
      expected: {
        prompt: "repo=hub   investigate   the sync  ",
        inputs: { repo: "hub", agent: "codex" },
      },
    },
    {
      name: "requires a mention boundary before removing the provider mention",
      message: "@MikoBot repo=hub investigate",
      mention: "@Miko",
      expected: {
        prompt: "@MikoBot repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "does not remove an embedded provider mention",
      message: "request @Miko repo=hub investigate",
      mention: "@Miko",
      expected: {
        prompt: "request @Miko repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
    {
      name: "stops at an undeclared key and preserves the entire remainder",
      message: "unknown=value repo=hub investigate",
      expected: {
        prompt: "unknown=value repo=hub investigate",
        inputs: { agent: "codex" },
      },
    },
  ])("$name", ({ message, mention, expected }) => {
    assert.deepEqual(parseInvocation(message, inputs, mention), {
      status: "accepted",
      ...expected,
    });
  });

  it.each([
    {
      name: "invalid choice",
      message: "repo=unknown investigate",
      expectedPrompt: "repo=unknown investigate",
      reason: /repo.*choice/iu,
    },
    {
      name: "duplicate key",
      message: "repo=hub repo=paseo investigate",
      expectedPrompt: "repo=hub repo=paseo investigate",
      reason: /duplicate.*repo/iu,
    },
  ])("preserves the complete prompt after a $name control-token rejection", (example) => {
    const result = parseInvocation(example.message, inputs);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.prompt, example.expectedPrompt);
      assert.match(result.reason, example.reason);
      assert.equal(typeof result.rejection.code, "string");
    }
  });

  it.each([
    ["required", "repo=hub investigate", "repo=hub investigate", /required input.*dry/iu],
    ["invalid choice", "repo=other investigate", "repo=other investigate", /repo.*choice/iu],
    [
      "invalid number",
      "count=not-a-number investigate",
      "count=not-a-number investigate",
      /count.*number/iu,
    ],
    ["invalid boolean", "dry=sometimes investigate", "dry=sometimes investigate", /dry.*boolean/iu],
    [
      "duplicate key",
      "repo=hub repo=paseo investigate",
      "repo=hub repo=paseo investigate",
      /duplicate.*repo/iu,
    ],
  ] as const)("rejects %s values before execution", (_name, message, expectedPrompt, error) => {
    const result = parseInvocation(
      message,
      _name === "required" || _name === "invalid boolean" ? requiredInputs : inputs,
    );
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.match(result.reason, error);
      assert.equal(result.prompt, expectedPrompt);
    }
  });

  it("does not implement a delimiter grammar", () => {
    assert.deepEqual(parseInvocation("-- repo=hub investigate", inputs), {
      status: "accepted",
      prompt: "-- repo=hub investigate",
      inputs: { agent: "codex" },
    });
  });
});
