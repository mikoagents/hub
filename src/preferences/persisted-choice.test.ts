import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { choiceFromStored } from "./persisted-choice.js";

const CHOICES = ["all", "enabled", "disabled"] as const;

describe("choiceFromStored", () => {
  it("keeps a stored choice and drops anything else", () => {
    assert.equal(choiceFromStored("disabled", CHOICES, "all"), "disabled");
    assert.equal(choiceFromStored("all", CHOICES, "all"), "all");
    assert.equal(choiceFromStored("unknown-status", CHOICES, "all"), "all");
    assert.equal(choiceFromStored(null, CHOICES, "all"), "all");
    assert.equal(choiceFromStored("", CHOICES, "all"), "all");
  });
});
