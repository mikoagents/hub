import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { it, vi } from "vitest";
import { respondOk } from "../contract/respond.js";
import { snapshotQueryOptions } from "../queries/index.js";
import { daemonProviderQueryKey, PROVIDER_SNAPSHOT_STALE_TIME_MS } from "./provider-snapshot.js";

const scope = {
  accountId: "alice",
  organizationId: "acme",
  daemonId: "studio",
  connectedAt: "2026-11-09T12:00:00.000Z",
  cwd: "/repo",
};

it("reuses a fresh provider snapshot when returning to the page and refreshes on invalidation", async () => {
  const client = new QueryClient();
  const load = vi.fn().mockResolvedValue(respondOk(["codex"]));
  const options = snapshotQueryOptions({
    queryKey: daemonProviderQueryKey(scope),
    queryFn: load,
    staleTime: PROVIDER_SNAPSHOT_STALE_TIME_MS,
  });
  try {
    await client.fetchQuery(options);
    const first = new QueryObserver(client, options);
    first.subscribe(() => {})();
    const returned = new QueryObserver(client, options);
    const unsubscribe = returned.subscribe(() => {});
    assert.deepEqual(returned.getCurrentResult().data, ["codex"]);
    assert.equal(load.mock.calls.length, 1);

    load.mockResolvedValue(respondOk(["codex", "claude"]));
    await client.invalidateQueries({ queryKey: options.queryKey });
    assert.deepEqual(client.getQueryData(options.queryKey), ["codex", "claude"]);
    assert.equal(load.mock.calls.length, 2);
    unsubscribe();
  } finally {
    client.clear();
  }
});

it("does not reuse another account, organization, daemon, connection or directory snapshot", async () => {
  const client = new QueryClient();
  const load = vi.fn().mockResolvedValue(respondOk(["codex"]));
  const read = (input: typeof scope) =>
    client.fetchQuery(
      snapshotQueryOptions({
        queryKey: daemonProviderQueryKey(input),
        queryFn: load,
        staleTime: PROVIDER_SNAPSHOT_STALE_TIME_MS,
      }),
    );
  try {
    await read(scope);
    await read({ ...scope, cwd: " /repo " });
    assert.equal(load.mock.calls.length, 1);
    for (const change of [
      { accountId: "bob" },
      { organizationId: "other" },
      { daemonId: "laptop" },
      { connectedAt: "2026-11-09T12:01:00.000Z" },
      { cwd: "/other" },
    ])
      await read({ ...scope, ...change });
    assert.equal(load.mock.calls.length, 6);
  } finally {
    client.clear();
  }
});

it("uses the explicit refresh loader even while cached data is fresh", async () => {
  const client = new QueryClient();
  const queryKey = daemonProviderQueryKey(scope);
  try {
    await client.fetchQuery(
      snapshotQueryOptions({
        queryKey,
        staleTime: PROVIDER_SNAPSHOT_STALE_TIME_MS,
        queryFn: async () => respondOk(["codex"]),
      }),
    );
    const refresh = vi.fn().mockResolvedValue(respondOk(["claude"]));
    await client.fetchQuery(snapshotQueryOptions({ queryKey, staleTime: 0, queryFn: refresh }));
    assert.equal(refresh.mock.calls.length, 1);
    assert.deepEqual(client.getQueryData(queryKey), ["claude"]);
  } finally {
    client.clear();
  }
});
