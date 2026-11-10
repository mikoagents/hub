import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { it } from "vitest";
import { closeServer } from "./close-server.js";

it("shuts down a listening Hub with an active upgraded daemon connection before awaiting the HTTP close callback", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const daemon = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(daemon, "open");
  let stopped = false;
  try {
    await closeServer(server, async () => {
      stopped = true;
      for (const client of sockets.clients) client.terminate();
    });
    assert.equal(stopped, true);
    assert.equal(server.listening, false);
  } finally {
    daemon.terminate();
    sockets.close();
    server.closeAllConnections();
    if (server.listening) server.close();
  }
});
