import { expect, test } from "vitest";
import { createMemoryDatabase } from "../db/memory.js";
import { DaemonAgents } from "../daemons/agents/index.js";
import {
  EXECUTION_PROTOCOL_VERSION as version,
  RequestSchema,
  type TimelinePage,
} from "../miko/protocol.js";
import { SessionTimelines } from "./service.js";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";

const agent = {
  nativeAgentId: "native",
  provider: "codex",
  providerSessionId: "provider-session",
  status: "idle" as const,
  cwd: "/repo",
  model: "model",
};
function page(first: number, last: number, max = last, epoch = "epoch"): TimelinePage {
  return {
    epoch,
    agent,
    reset: false,
    hasOlder: first > 1,
    hasNewer: last < max,
    window: { minSeq: 1, maxSeq: max, nextSeq: max + 1 },
    rows: Array.from({ length: last - first + 1 }, (_, i) => ({
      seq: first + i,
      timestamp: "2026-11-09T10:00:00Z",
      item: { type: "assistant_message", text: String(first + i) },
    })),
  };
}
async function fixture() {
  const database = createMemoryDatabase();
  await database.saveAgentSession({
    id: "session",
    organizationId: "org",
    projectId: "project",
    daemonId: "daemon",
    agentId: "public",
    workspaceId: "workspace",
    continuationKey: null,
    runtimeBinding: { provider: "codex", nativeAgentId: "native" },
    compatibility: "same",
    capabilityTokenHash: "hash",
    tools: [],
    creationOptions: { provider: "codex", cwd: "/repo", env: {}, toolPolicy: { preapproved: [] } },
  });
  const responses: TimelinePage[] = [];
  const requests: ReturnType<typeof RequestSchema.parse>[] = [];
  const agents = new DaemonAgents((frame) => {
    const request = RequestSchema.parse(JSON.parse(frame));
    requests.push(request);
    agents.receive({
      type: "miko.response",
      version,
      requestId: request.requestId,
      result: responses.shift(),
    });
  });
  let connected = true;
  const service = new SessionTimelines(
    database,
    () =>
      connected
        ? {
            agents,
            getProviderSnapshot: async () => {
              throw new Error("unused");
            },
            refreshProviderSnapshot: async () => {},
            validateAgentConfiguration: async () => ({ valid: true }),
          }
        : undefined,
    "secret",
  );
  return {
    database,
    service,
    responses,
    requests,
    disconnect: () => {
      connected = false;
    },
  };
}

test("session reads catch up missed rows, deduplicate repeated pages, backfill older history and retain offline copies", async () => {
  const f = await fixture();
  f.responses.push(page(201, 400));
  expect((await f.service.read("session")).rows).toHaveLength(200);
  f.responses.push(page(401, 600, 605), page(601, 605));
  const caught = await f.service.read("session");
  expect(caught.state).toMatchObject({ endSeq: 605, hasNewer: false });
  expect(f.requests[1]?.input).toMatchObject({
    agentId: "public",
    direction: "after",
    cursor: { epoch: "epoch", seq: 400 },
  });
  f.responses.push(page(1, 200, 605));
  expect((await f.service.read("session", 201)).hasOlder).toBe(false);
  f.disconnect();
  const offline = await f.service.read("session", 201);
  expect(offline.availability).toBe("offline");
  expect(offline.rows.map((row) => row.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
});

test("epoch replacement discards stale rows and stored history is scrubbed before offline reads", async () => {
  const f = await fixture();
  const initial = page(1, 3);
  initial.rows[0]!.item["text"] =
    `echo ${deriveAgentExecutionCompletionToken("secret", "session:session")}`;
  initial.rows[0]!.item["headers"] = { Authorization: "Bearer private" };
  f.responses.push(initial);
  const captured = await f.service.read("session");
  expect(captured.rows[0]?.item).toMatchObject({ text: "echo [Redacted]", headers: "[Redacted]" });
  f.responses.push({ ...page(1, 1, 1, "new-epoch"), reset: true });
  const replaced = await f.service.read("session");
  expect(replaced.rows.map((row) => row.seq)).toEqual([1]);
  expect(replaced.state?.epoch).toBe("new-epoch");
});

test("a mismatched native binding is never cached", async () => {
  const f = await fixture();
  f.responses.push({ ...page(1, 1), agent: { ...agent, nativeAgentId: "another-owner" } });
  const result = await f.service.read("session");
  expect(result.availability).toBe("unavailable");
  expect(result.state).toBeNull();
  expect(result.rows).toEqual([]);
});

test("a delayed read from a retired epoch cannot overwrite a newer cached history", async () => {
  const f = await fixture();
  await f.database.sessionTimelines.save("session", page(1, 1));
  await f.database.sessionTimelines.save("session", page(1, 2, 2, "new-epoch"));
  await f.database.sessionTimelines.save("session", page(1, 3), "epoch");
  expect((await f.database.sessionTimelines.state("session"))?.epoch).toBe("new-epoch");
  expect((await f.database.sessionTimelines.rows("session")).map((row) => row.seq)).toEqual([1, 2]);
});

test("an authoritative reset within one epoch does not stitch disjoint saved ranges", async () => {
  const f = await fixture();
  await f.database.sessionTimelines.save("session", page(1, 5));
  await f.database.sessionTimelines.save("session", { ...page(50, 55), reset: true });
  expect((await f.database.sessionTimelines.rows("session")).map((row) => row.seq)).toEqual([
    50, 51, 52, 53, 54, 55,
  ]);
  expect(await f.database.sessionTimelines.state("session")).toMatchObject({
    startSeq: 50,
    endSeq: 55,
    hasOlder: true,
  });
});
