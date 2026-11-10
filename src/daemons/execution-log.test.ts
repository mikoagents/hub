import assert from "node:assert/strict";
import { it } from "vitest";
import { executionLogEvent } from "./execution-log.js";

it("retains messages and tool output while scrubbing nested credentials and echoed Hub tokens", () => {
  assert.deepEqual(
    executionLogEvent(
      {
        type: "timeline",
        item: {
          text: "Finished reading source.ts",
          body: "Tool output",
          code: "const value = 1",
          message: "Done",
          arguments: {
            headers: { Authorization: "Bearer hidden" },
            env: { API_KEY: "hidden" },
            password: "hidden",
            apiKey: "hidden",
          },
          output: ["Bearer secret-token", "HUB_EXECUTION_TOKEN=secret-value", "echo exact-token"],
        },
      },
      ["exact-token"],
    ),
    {
      type: "timeline",
      item: {
        text: "Finished reading source.ts",
        body: "Tool output",
        code: "const value = 1",
        message: "Done",
        arguments: {
          headers: "[Redacted]",
          env: "[Redacted]",
          password: "[Redacted]",
          apiKey: "[Redacted]",
        },
        output: ["Bearer [Redacted]", "HUB_EXECUTION_TOKEN=[Redacted]", "echo [Redacted]"],
      },
    },
  );
});

it("retains numeric usage counters without weakening credential redaction", () => {
  assert.deepEqual(
    executionLogEvent({
      lastUsage: { inputTokens: 100, outputTokens: 20 },
      authToken: 123,
      inputTokens: "credential",
    }),
    {
      lastUsage: { inputTokens: 100, outputTokens: 20 },
      authToken: "[Redacted]",
      inputTokens: "[Redacted]",
    },
  );
});
