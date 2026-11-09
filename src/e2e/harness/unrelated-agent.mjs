#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const [packagesRoot, daemonHost, cwd] = process.argv.slice(2);
if (!packagesRoot || !daemonHost || !cwd)
  throw new Error("usage: unrelated-agent <packages-root> <daemon-host> <cwd>");
const requireFromMiko = createRequire(join(packagesRoot, "package.json"));
const { WebSocket } = requireFromMiko("ws");
const socket = new WebSocket(`ws://${daemonHost}/ws`);
const ready = new Promise((resolve, reject) => {
  socket.once("message", resolve);
  socket.once("error", reject);
});
socket.on("open", () =>
  socket.send(
    JSON.stringify({
      type: "hello",
      clientId: "hub-e2e-unrelated-local",
      clientType: "cli",
      protocolVersion: 1,
      capabilities: { all_providers: true, selective_agent_timeline: true },
    }),
  ),
);
const timeout = setTimeout(() => socket.terminate(), 15_000);
try {
  await ready;
  const result = await request("create_agent_request", {
    idempotencyKey: randomUUID(),
    config: {
      provider: "hub-e2e",
      cwd,
      title: "Unrelated local activity",
      toolPolicy: { preapproved: [] },
    },
    env: {},
  });
  const agent = result.agent;
  if (!agent || typeof agent.id !== "string") throw new Error("Local native agent creation failed");
  await request("send_agent_message_request", {
    agentId: agent.id,
    messageId: randomUUID(),
    text: "local unrelated activity",
  });
  process.stdout.write(`${JSON.stringify(agent.id)}\n`);
} finally {
  clearTimeout(timeout);
  socket.close();
}

function request(type, fields) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const listener = (raw) => {
      const frame = JSON.parse(raw.toString());
      const payload = frame.message?.payload;
      if (payload?.requestId !== requestId) return;
      socket.off("message", listener);
      socket.off("close", closed);
      if (payload.error) reject(new Error(payload.error));
      else resolve(payload);
    };
    const closed = () => {
      socket.off("message", listener);
      reject(new Error("Local native connection closed"));
    };
    socket.on("message", listener);
    socket.once("close", closed);
    socket.send(JSON.stringify({ type: "session", message: { type, requestId, ...fields } }));
  });
}
