import type { Server } from "node:http";

/** Refuse new requests, close runtime-owned WebSockets, then await the HTTP drain. */
export async function closeServer(server: Server, stopRuntime: () => Promise<void>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  // Attach a rejection handler while runtime cleanup is in progress.
  void closed.catch(() => {});
  await stopRuntime();
  server.closeIdleConnections();
  await closed;
}
