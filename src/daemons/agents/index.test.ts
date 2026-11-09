import { expect, test, vi } from "vitest";
import { DaemonAgents } from "./index.js";
import { RequestSchema, EXECUTION_PROTOCOL_VERSION as version } from "../../miko/protocol.js";
import type { DaemonCreateAgentOptions } from "../protocol.js";
import { DaemonResponseLostError } from "../protocol.js";
const snapshot = {
  id: "session",
  workspaceId: "workspace",
  status: "idle",
  provider: "codex/custom",
  nativeAgentId: "native",
};
const options: DaemonCreateAgentOptions = {
  provider: "codex/custom",
  cwd: "/repo",
  env: { TASK: "explicit" },
  providerOptions: { sandbox_mode: "read-only" },
  toolPolicy: { preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }] },
};
function connect() {
  const requests: Array<ReturnType<typeof RequestSchema.parse>> = [];
  const agents = new DaemonAgents((frame) => {
    const request = RequestSchema.parse(JSON.parse(frame));
    requests.push(request);
    let result: unknown = null;
    if (request.operation === "create" || request.operation === "get") result = snapshot;
    agents.receive({ type: "miko.response", version, requestId: request.requestId, result });
  });
  return { requests, agents };
}
test("public creation binds provider and preserves the exact provider configuration and prompt", async () => {
  const { agents, requests } = connect();
  await agents.create("key", options);
  const text = "  author prompt\n".repeat(1000);
  await agents.send("session", "message", text);
  expect(requests.map((r) => r.operation)).toEqual(["receipt", "create", "receipt", "submit"]);
  expect(requests[1]?.input).toEqual({ key: "key", options });
  expect(requests[3]?.input).toEqual({ agentId: "session", messageId: "message", text });
  expect(requests.every((r) => r.type === "miko.request")).toBe(true);
});
test("watch delivers authoritative snapshots through the public event envelope and releases subscriptions", async () => {
  const { agents, requests } = connect(),
    listener = vi.fn();
  const unsubscribe = await agents.watch("session", listener);
  agents.receive({
    type: "miko.event",
    version,
    event: { type: "agent_snapshot", agent: snapshot, timestamp: new Date().toISOString() },
  });
  expect(listener).toHaveBeenCalledWith(
    expect.objectContaining({ type: "agent_snapshot", agent: snapshot }),
  );
  unsubscribe();
  expect(requests.map((r) => r.operation)).toEqual(["watch", "unwatch"]);
});
test("disconnect rejects in-flight requests and prevents further submission", async () => {
  const agents = new DaemonAgents(() => {}),
    pending = agents.get("session");
  agents.close();
  await expect(pending).rejects.toBeInstanceOf(DaemonResponseLostError);
  await expect(agents.get("session")).rejects.toBeInstanceOf(DaemonResponseLostError);
});
test("a pending durable submission is queried and kept uncertain without resubmitting", async () => {
  const operations: string[] = [];
  const agents = new DaemonAgents((frame) => {
    const request = RequestSchema.parse(JSON.parse(frame));
    operations.push(request.operation);
    agents.receive({
      type: "miko.response",
      version,
      requestId: request.requestId,
      result: { state: "pending" },
    });
  });
  await expect(agents.send("session", "message", "text")).rejects.toBeInstanceOf(
    DaemonResponseLostError,
  );
  expect(operations).toEqual(["receipt"]);
});
test("native frames and mismatched execution protocol versions are never accepted", () => {
  const { agents } = connect();
  expect(agents.receive({ type: "session", message: { type: "agent_update" } })).toBe(false);
  expect(
    agents.receive({ type: "miko.response", version: "1.0.0", requestId: "id", result: snapshot }),
  ).toBe(false);
});
