import { DaemonAgents } from "./agents/index.js";
import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import type { AuthServer } from "../auth/server.js";
import { createMemoryDatabase } from "../db/memory.js";
import { enrollTestDaemon, TEST_DAEMON_ID } from "../test-utils/project-configuration.js";
import type { DaemonConnection } from "./protocol.js";
import { DaemonProviderCatalog } from "./provider-catalog.js";
import type { HubProviderSnapshot } from "../hub/protocol.js";

describe("daemon provider catalog", () => {
  it("reuses successful snapshots across requests and coalesces concurrent reads", async () => {
    const fixture = await catalogFixture();
    const results = await Promise.all([fixture.read(), fixture.read(), fixture.read()]);
    assert.deepEqual(results, [snapshot, snapshot, snapshot]);
    await fixture.read();
    assert.equal(fixture.get.mock.calls.length, 1);
    assert.equal(fixture.refresh.mock.calls.length, 0);
  });

  it("expires snapshots and keeps working directory scopes separate", async () => {
    const fixture = await catalogFixture();
    await fixture.read();
    await fixture.read({ cwd: "/repo" });
    await fixture.read({ cwd: " /repo " });
    await fixture.read({ cwd: "/other" });
    assert.equal(fixture.get.mock.calls.length, 3);
    fixture.advance(5 * 60_000);
    await fixture.read();
    assert.equal(fixture.get.mock.calls.length, 4);
  });

  it("only forces provider discovery on explicit refresh and shares that refresh", async () => {
    const fixture = await catalogFixture();
    await fixture.read();
    const updated = { ...snapshot, requestId: "updated", entries: [] };
    fixture.get.mockResolvedValue(updated);
    const results = await Promise.all([
      fixture.read({ refresh: true }),
      fixture.read({ refresh: true }),
    ]);
    assert.deepEqual(results, [updated, updated]);
    assert.deepEqual(await fixture.read(), updated);
    assert.equal(fixture.refresh.mock.calls.length, 1);
    assert.equal(fixture.get.mock.calls.length, 2);
  });

  it("does not reuse snapshots after reconnect even when the wrapper changes on every lookup", async () => {
    const fixture = await catalogFixture();
    await fixture.read();
    fixture.connection.agents = new DaemonAgents(() => {});
    const updated = { ...snapshot, requestId: "reconnected", entries: [] };
    fixture.get.mockResolvedValue(updated);
    assert.deepEqual(await fixture.read(), updated);
    assert.equal(fixture.get.mock.calls.length, 2);
  });

  it("rechecks access and connection availability before serving cached data", async () => {
    const fixture = await catalogFixture();
    await fixture.read();
    await assert.rejects(fixture.read({ organizationSlug: "other" }));
    fixture.disconnect();
    await assert.rejects(fixture.read(), /daemon_not_connected/u);
    assert.equal(fixture.get.mock.calls.length, 1);
  });

  it("does not cache failed reads", async () => {
    const fixture = await catalogFixture();
    fixture.get.mockRejectedValueOnce(new Error("provider lookup failed"));
    await assert.rejects(fixture.read(), /provider lookup failed/u);
    assert.deepEqual(await fixture.read(), snapshot);
    assert.equal(fixture.get.mock.calls.length, 2);
  });

  it("does not let a superseded read overwrite an explicit refresh", async () => {
    const fixture = await catalogFixture();
    let resolveOlder!: (value: HubProviderSnapshot) => void;
    const older = new Promise<HubProviderSnapshot>((resolve) => {
      resolveOlder = resolve;
    });
    fixture.get.mockReturnValueOnce(older);
    const read = fixture.read();
    await vi.waitFor(() => assert.equal(fixture.get.mock.calls.length, 1));
    const updated = { ...snapshot, requestId: "refreshed", entries: [] };
    fixture.get.mockResolvedValue(updated);
    assert.deepEqual(await fixture.read({ refresh: true }), updated);
    resolveOlder(snapshot);
    await read;
    assert.deepEqual(await fixture.read(), updated);
  });

  it("authorizes the organization and refreshes before returning its daemon snapshot", async () => {
    const database = createMemoryDatabase({
      memberships: [
        {
          userId: "user-1",
          organizationId: "org-1",
          organizationName: "Acme",
          organizationSlug: "acme",
          membershipId: "membership-1",
          role: "member",
        },
      ],
    });
    await enrollTestDaemon(database, "org-1");
    const calls: string[] = [];
    const connection: DaemonConnection = {
      agents: new DaemonAgents(() => {
        throw new Error("Native agents are not used by this fixture");
      }),
      refreshProviderSnapshot: async ({ cwd }) => {
        calls.push(`refresh:${cwd}`);
      },
      validateAgentConfiguration: async () => ({ valid: true }),
      getProviderSnapshot: async ({ cwd }) => {
        calls.push(`get:${cwd}`);
        return {
          requestId: "snapshot-1",
          ...(cwd === undefined ? {} : { cwd }),
          entries: [{ provider: "codex", status: "ready", enabled: true }],
          generatedAt: "2026-09-02T12:00:00.000Z",
        };
      },
    };
    const catalog = new DaemonProviderCatalog(database, accountAuth(), (daemonId) =>
      daemonId === TEST_DAEMON_ID ? connection : undefined,
    );

    const result = await catalog.read(new Request("https://hub.test/o/acme/triggers"), {
      organizationSlug: "acme",
      daemonId: TEST_DAEMON_ID,
      cwd: "/repo",
      refresh: true,
    });

    assert.deepEqual(calls, ["refresh:/repo", "get:/repo"]);
    assert.equal(result.entries[0]?.provider, "codex");
  });
});

const snapshot: HubProviderSnapshot = {
  entries: [{ provider: "codex", status: "ready", enabled: true }],
  generatedAt: "2026-09-02T12:00:00.000Z",
};

async function catalogFixture() {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "membership-1",
        role: "member",
      },
    ],
  });
  await enrollTestDaemon(database, "org-1");
  const get = vi.fn<DaemonConnection["getProviderSnapshot"]>().mockResolvedValue(snapshot);
  const refresh = vi.fn<DaemonConnection["refreshProviderSnapshot"]>().mockResolvedValue();
  const connection: DaemonConnection = {
    agents: new DaemonAgents(() => {}),
    getProviderSnapshot: get,
    refreshProviderSnapshot: refresh,
    validateAgentConfiguration: async () => ({ valid: true }),
  };
  let connected = true;
  let now = 0;
  const catalog = new DaemonProviderCatalog(
    database,
    accountAuth(),
    () => (connected ? { ...connection } : undefined),
    () => now,
  );
  return {
    connection,
    get,
    refresh,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    disconnect: () => {
      connected = false;
    },
    read: (input: { organizationSlug?: string; cwd?: string; refresh?: boolean } = {}) =>
      catalog.read(new Request("https://hub.test/o/acme/daemons"), {
        organizationSlug: "acme",
        daemonId: TEST_DAEMON_ID,
        ...input,
      }),
  };
}

function accountAuth(): AuthServer {
  return {
    handle: () => Promise.resolve(new Response()),
    resources: () => Promise.reject(new Error("unused")),
    resolveOrganizationAccess: () => Promise.reject(new Error("unused")),
    resolveAccount: () =>
      Promise.resolve({
        session: { id: "session-1", activeOrganizationId: "org-1" },
        account: { id: "user-1", name: "User", email: "user@example.test" },
        isInstanceOperator: false,
      }),
    rejectCookieMutation: () => undefined,
    close: () => Promise.resolve(),
  };
}
