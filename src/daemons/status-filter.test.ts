import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { daemonFilterEmpty, daemonListStatus, daemonMatchesStatus } from "./status-filter.js";

const connected = { status: "active", presence: "connected" } as const;
const offline = { status: "active", presence: "offline" } as const;
const revoked = { status: "revoked", presence: "connected" } as const;

describe("daemon status filter", () => {
  it("matches the pill the table shows, with revoked ahead of presence", () => {
    assert.equal(daemonListStatus(connected), "connected");
    assert.equal(daemonListStatus(offline), "offline");
    assert.equal(daemonListStatus(revoked), "revoked");
    assert.equal(daemonMatchesStatus(revoked, "connected"), false);
    assert.equal(daemonMatchesStatus(revoked, "revoked"), true);
    assert.equal(daemonMatchesStatus(offline, "all"), true);
    assert.equal(daemonMatchesStatus(connected, "offline"), false);
  });

  it("names the empty state after the selected status", () => {
    assert.equal(daemonFilterEmpty("connected").title, "No connected daemons");
    assert.equal(daemonFilterEmpty("offline").title, "No offline daemons");
    assert.equal(daemonFilterEmpty("revoked").description, "Choose All to view every daemon.");
  });
});
