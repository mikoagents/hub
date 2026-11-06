import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileTriggerDocument } from "../triggers/configuration/index.js";
import { evaluateExpression, renderExpressionTemplate } from "./expression.js";
import { compileJsonSchema } from "./json-schema.js";

const iterativeTrigger = `
name: repair
max_runtime: 4h
on:
  manual.run: {}
run:
  continuation: { mode: new }
  iterations: { max_runs: 3 }
  target: { daemon: devbox, cwd: /repo }
  agent: { provider: codex, mode: auto-review }
  max_runtime: 50m
  prompt: Repair the failing coverage gate.
`;

describe("user continues unfinished work without another webhook", () => {
  it("user passes a saved checkpoint to a fresh execution and stops after completion", () => {
    // Given an opted-in repair with three execution segments.
    const trigger = compileTriggerDocument(iterativeTrigger).events[0]!;
    // When its first execution saves unfinished coverage work.
    const first = trigger.steps[0]!;
    const second = trigger.steps[1]!;
    const context = {
      prompt: "repair",
      context: {},
      inputs: {},
      values: {},
      steps: {
        [first.id]: {
          status: "succeeded",
          output: { outcome: "continue", checkpoint: "tree=abc; add location permission tests" },
        },
      },
    };
    // Then another segment is eligible and receives the checkpoint, while completion stops it.
    assert.equal(trigger.steps.length, 3);
    assert.deepEqual(second.iteration, { index: 2, limit: 3 });
    assert.equal(evaluateExpression(second.condition!, context), true);
    const prompt = second.prompt
      .map((block) =>
        renderExpressionTemplate(block.kind === "text" ? block.value : block.content, context),
      )
      .join("\n");
    assert.equal(prompt.includes("tree=abc; add location permission tests"), true);
    context.steps[first.id]!.output.outcome = "complete";
    assert.equal(evaluateExpression(second.condition!, context), false);
  });

  it("user cannot report a coverage failure as an external blocker or omit the checkpoint", () => {
    // Given the completion contract exposed to an iterative agent.
    const step = compileTriggerDocument(iterativeTrigger).events[0]!.steps[0]!;
    const output = compileJsonSchema(step.output!.schema);
    // When the agent reports fixable work, a real permission blocker, or incomplete output.
    const outcomes = [
      { outcome: "continue", checkpoint: "coverage now 65%; finish photo cancellation tests" },
      {
        outcome: "blocked",
        checkpoint: "saved tree",
        blocker: { kind: "permission", reason: "GitHub App write permission revoked" },
      },
      {
        outcome: "blocked",
        checkpoint: "saved tree",
        blocker: { kind: "coverage", reason: "below threshold" },
      },
      { outcome: "continue" },
    ].map((value) => output.validate(value));
    // Then only continuing work and a documented external blocker are valid.
    assert.deepEqual(outcomes, [true, true, false, false]);
  });

  it("user cannot silently exhaust every segment while declaring unfinished work complete", () => {
    // Given the final segment in a bounded iterative repair.
    const last = compileTriggerDocument(iterativeTrigger).events[0]!.steps.at(-1)!;
    const output = compileJsonSchema(last.output!.schema);
    // When the agent tries to finish with more repair work still pending.
    const unfinished = output.validate({ outcome: "continue", checkpoint: "tests still failing" });
    const complete = output.validate({
      outcome: "complete",
      checkpoint: "pushed abc; verified resolved threads",
    });
    // Then exhaustion cannot be recorded as successful completion.
    assert.equal(unfinished, false);
    assert.equal(complete, true);
  });

  it("user must give iterative work an explicit budget and separate sessions", () => {
    // Given a valid repair configuration with a bounded workflow and fresh sessions.
    const invalidDocuments = [
      iterativeTrigger.replace("max_runtime: 4h\n", ""),
      iterativeTrigger.replace("mode: new", "mode: conversation"),
      iterativeTrigger.replace("iterations: { max_runs: 3 }", "iterations: { max_runs: 1 }"),
      iterativeTrigger.replace("iterations: { max_runs: 3 }", "iterations: { max_runs: 25 }"),
      iterativeTrigger.replace("  prompt:", "  output: { schema: { type: object } }\n  prompt:"),
    ];
    // When a caller omits the deadline or supplies incompatible run options.
    const failures = invalidDocuments.map((document) => {
      try {
        compileTriggerDocument(document);
        return false;
      } catch {
        return true;
      }
    });
    // Then every incompatible configuration is rejected before an agent starts.
    assert.deepEqual(failures, [true, true, true, true, true]);
  });
});
