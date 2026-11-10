import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { activityFilterEmpty, activityMatchesStatus } from "./activity-filter.js";

describe("activity status filter", () => {
  it("shows every run under All and only the matching outcome otherwise", () => {
    const statuses = [
      "running",
      "succeeded",
      "failed",
      "timed_out",
      "rejected",
      "queued",
      "waiting",
    ];
    assert.deepEqual(
      statuses.filter((status) => activityMatchesStatus(status, "all")),
      statuses,
    );
    assert.deepEqual(
      statuses.filter((status) => activityMatchesStatus(status, "running")),
      ["running", "queued", "waiting"],
    );
    assert.deepEqual(
      statuses.filter((status) => activityMatchesStatus(status, "succeeded")),
      ["succeeded"],
    );
    assert.deepEqual(
      statuses.filter((status) => activityMatchesStatus(status, "failed")),
      ["failed", "timed_out", "rejected"],
    );
  });

  it("explains an empty filtered list and keeps the unfiltered empty title", () => {
    assert.deepEqual(activityFilterEmpty("all"), { title: "No activity" });
    assert.deepEqual(activityFilterEmpty("running"), {
      title: "No running activity",
      description: "Choose All to view every run.",
    });
    assert.equal(activityFilterEmpty("failed").title, "No failed activity");
  });
});
