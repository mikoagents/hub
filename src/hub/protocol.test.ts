import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { ProviderSnapshotSchema } from "../miko/protocol.js";

describe("Hub provider snapshot protocol", () => {
  it("keeps model thinking options and provider modes", () => {
    const result = ProviderSnapshotSchema.parse({
      entries: [
        {
          provider: "codex",
          status: "ready",
          models: [
            {
              provider: "codex",
              id: "gpt-5.4",
              label: "GPT-5.4",
              thinkingOptions: [{ id: "xhigh", label: "Extra high", isDefault: true }],
            },
          ],
          modes: [{ id: "full-access", label: "Full access" }],
        },
      ],
      generatedAt: "2026-09-02T12:00:00.000Z",
    });

    assert.equal(result.entries[0]?.models?.[0]?.thinkingOptions?.[0]?.id, "xhigh");
    assert.equal(result.entries[0]?.modes?.[0]?.id, "full-access");
  });
});
