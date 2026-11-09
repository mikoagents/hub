#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packagesRoot, daemonHost, cwd] = process.argv.slice(2);
if (!packagesRoot || !daemonHost || !cwd)
  throw new Error("usage: unrelated-agent <packages-root> <daemon-host> <cwd>");
const requireFromMiko = createRequire(join(packagesRoot, "package.json"));
const { WebSocket } = requireFromMiko("ws");
const { PaseoBackend } = await import(
  pathToFileURL(
    join(packagesRoot, "node_modules/@mikoagents/server/dist/server/server/miko/paseo-backend.js"),
  ).toString()
);
const socket = new WebSocket(`ws://${daemonHost}/ws`);
const backend = new PaseoBackend((frame) => socket.send(frame));
socket.on("message", (frame) => backend.receive(JSON.parse(frame.toString())));
socket.on("error", () => backend.close());
socket.on("close", () => backend.close());
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
  await backend.ready;
  const agent = await backend.create(randomUUID(), {
    backend: "local",
    provider: "hub-e2e",
    cwd,
    title: "Unrelated local activity",
    env: {},
    toolPolicy: { preapproved: [] },
  });
  await backend.send(agent.id, randomUUID(), "local unrelated activity");
  process.stdout.write(`${JSON.stringify(agent.id)}\n`);
} finally {
  clearTimeout(timeout);
  backend.close();
  socket.close();
}
