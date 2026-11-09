import { z } from "zod";
import { RequestSchema, EXECUTION_PROTOCOL_VERSION as version } from "../../miko/protocol.js";
/** Adapt the test fixture's historical operation vocabulary; no native frames cross a socket. */
export function fixtureRequest(value: unknown): unknown {
  const request = RequestSchema.parse(value),
    i = z.record(z.string(), z.unknown()).parse(request.input),
    requestId = request.requestId;
  const o = z.record(z.string(), z.unknown()).parse(i["options"] ?? {});
  const mapping: Record<string, string> = {
    create: "create_agent_request",
    get: "fetch_agent_request",
    submit: "send_agent_message_request",
    cancel: "cancel_agent_request",
    cleanup: "archive_workspace_request",
    providers: "get_providers_snapshot_request",
    refresh: "refresh_providers_snapshot_request",
    validate: "hub.execution.agent.validate.request",
    watch: "fetch_agents_request",
    unwatch: "agent.timeline.set_subscription.request",
  };
  return {
    type: "session",
    message:
      request.operation === "create"
        ? {
            type: mapping[request.operation],
            requestId,
            idempotencyKey: i["key"],
            config: { ...o, modeId: o["mode"] },
            env: o["env"],
            background: o["background"],
            worktree: o["worktree"],
          }
        : {
            ...i,
            type: mapping[request.operation],
            requestId,
            modeId: i["mode"],
            activeTurnBehavior: "steer",
            includeBackground: true,
          },
  };
}
export function fixtureResponse(value: unknown): unknown {
  const { type, payload } = z
    .object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })
    .parse(value);
  if (type === "status" && payload["status"] === "server_info")
    return { type: "miko.ready", version, permissions: payload["permissions"] };
  if (type === "agent_stream")
    return {
      type: "miko.event",
      version,
      event: {
        type,
        agentId: payload["agentId"],
        timestamp: payload["timestamp"] ?? new Date().toISOString(),
        event: payload["event"],
      },
    };
  if (type === "agent_update")
    return {
      type: "miko.event",
      version,
      event: { type, agent: bind(payload["agent"]), timestamp: new Date().toISOString() },
    };
  const error = payload["error"];
  let result: unknown = null;
  if (payload["agent"]) result = bind(payload["agent"]);
  else if (type === "get_providers_snapshot_response") result = payload;
  else if (type === "hub.execution.agent.validate.response")
    result = payload["valid"] ? { valid: true } : { valid: false, issues: payload["issues"] };
  return {
    type: "miko.response",
    version,
    requestId: payload["requestId"],
    ...(error
      ? { error: { code: z.string().parse(error), message: z.string().parse(error) } }
      : { result }),
  };
}
function bind(value: unknown) {
  const agent = z.record(z.string(), z.unknown()).parse(value);
  return {
    ...agent,
    provider: agent["provider"] ?? "codex",
    nativeAgentId: agent["id"],
  };
}

export function handleFixtureReceipt(value: unknown, send: (frame: string) => void): boolean {
  const request = RequestSchema.safeParse(value);
  if (!request.success) return false;
  if (request.data.operation !== "receipt") return false;
  send(
    JSON.stringify({
      type: "miko.response",
      version,
      requestId: request.data.requestId,
      result: null,
    }),
  );
  return true;
}
