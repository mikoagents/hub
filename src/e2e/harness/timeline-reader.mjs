#!/usr/bin/env node
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packagesRoot, daemonHost, agentId, mode] = process.argv.slice(2);
if (!packagesRoot || !daemonHost || !agentId) {
  throw new Error("usage: timeline-reader <packages-root> <daemon-host> <agent-id>");
}

const requireFromPaseo = createRequire(join(packagesRoot, "package.json"));
const { WebSocket } = requireFromPaseo("ws");
const { DaemonClient } = await import(
  pathToFileURL(
    join(packagesRoot, "node_modules/@mikoagents/client/dist/daemon-client.js"),
  ).toString()
);
const client = new DaemonClient({
  url: `ws://${daemonHost}/ws`,
  clientId: "hub-real-agent-timeline-reader",
  clientType: "cli",
  reconnect: { enabled: false },
  webSocketFactory(url, config) {
    return new WebSocket(url, config?.protocols, { headers: config?.headers });
  },
});

try {
  await client.connect();
  if (mode === "provider") {
    const result = await client.fetchAgent(agentId);
    if (!result) throw new Error("Native agent not found");
    process.stdout.write(`${JSON.stringify(result.agent.provider)}\n`);
  } else {
    const timeline = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      projection: "canonical",
      limit: 200,
      timeout: 10_000,
    });
    process.stdout.write(`${JSON.stringify(timeline.entries.map((entry) => entry.item))}\n`);
  }
} finally {
  await client.close();
}
