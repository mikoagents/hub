import { DaemonAgents } from "./agents/index.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Logger } from "pino";
import type { Database, DaemonRecord } from "../db/types.js";
import { reportFailure, type FailureKind } from "../failures/index.js";
import { logger as defaultLogger } from "../logger.js";
import {
  EXECUTION_PROTOCOL_HEADER,
  EXECUTION_PROTOCOL_VERSION,
  HelloSchema,
  ReadySchema,
} from "../miko/protocol.js";
import type { DaemonConnection } from "./protocol.js";
interface ActiveSocket {
  agents: DaemonAgents;
  generation: number;
  socket: WebSocket;
  daemon: DaemonRecord;
  ready: boolean;
  presenceReady: Promise<void>;
}

type DaemonConnectedHandler = (daemon: DaemonRecord) => void | Promise<void>;
type DaemonRevokedHandler = (daemon: DaemonRecord) => void | Promise<void>;

export class ActiveDaemonRegistry {
  private readonly active = new Map<string, ActiveSocket>();
  private readonly connectedHandlers = new Set<DaemonConnectedHandler>();
  private readonly revokedHandlers = new Set<DaemonRevokedHandler>();
  private readonly presenceWrites = new Set<Promise<void>>();
  private generation = 0;

  constructor(
    private readonly database: Pick<Database, "setDaemonPresence" | "touchDaemon">,
    private readonly clock: DaemonClock = systemDaemonClock,
    private readonly failureLogger: Pick<Logger, "warn" | "error"> = defaultLogger,
  ) {}

  accept(daemon: DaemonRecord, socket: WebSocket): void {
    const previous = this.active.get(daemon.id);
    const active: ActiveSocket = {
      agents: new DaemonAgents(
        (frame) => socket.send(frame),
        () => this.clock.nowDate(),
        (error, operation) => this.report(error, operation, daemon.id),
      ),
      generation: ++this.generation,
      socket,
      daemon,
      ready: false,
      presenceReady: Promise.resolve(),
    };
    this.active.set(daemon.id, active);
    previous?.agents.close();
    previous?.socket.close(4001, "replaced");
    socket.on("message", (data) => this.receive(active, readText(data)));
    socket.on("error", (error) => {
      // A peer that sends a malformed control frame (e.g. an invalid close
      // status code) makes the `ws` receiver emit `error` on this socket.
      // Node's EventEmitter rethrows unlistened `error` events as an
      // uncaught exception, which without this listener kills the whole
      // Hub process over one bad daemon connection. Report and let the
      // subsequent `close` event drive the normal offline-presence cleanup.
      this.report(error, "daemon.socket.error", daemon.id, "network");
    });
    socket.on("close", () => {
      active.agents.close();
      if (this.active.get(daemon.id)?.generation === active.generation) {
        this.active.delete(daemon.id);
        const write = active.presenceReady.then(() =>
          this.database.setDaemonPresence(daemon.id, "offline"),
        );
        this.presenceWrites.add(write);
        void write.then(
          () => this.presenceWrites.delete(write),
          (error: unknown) => {
            this.report(error, "daemon.presence.offline", daemon.id);
          },
        );
      }
    });
    socket.send(
      JSON.stringify(
        HelloSchema.parse({ type: "miko.hello", version: EXECUTION_PROTOCOL_VERSION }),
      ),
    );
  }

  onConnected(handler: DaemonConnectedHandler): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  onRevoked(handler: DaemonRevokedHandler): () => void {
    this.revokedHandlers.add(handler);
    return () => this.revokedHandlers.delete(handler);
  }

  connection(daemonId: string): DaemonConnection | undefined {
    const active = this.active.get(daemonId);
    if (!active?.ready || !active.daemon.permissions.includes("hub.execute")) return undefined;
    return {
      agents: this.active.get(daemonId)!.agents,
      getProviderSnapshot: (options) => active.agents.providers(options),
      refreshProviderSnapshot: (options) => active.agents.refresh(options),
      validateAgentConfiguration: (agent) => this.validateAgentConfiguration(daemonId, agent),
    };
  }

  validateAgentConfiguration(
    daemonId: string,
    agent: import("../config/compiler.js").CompiledAgent,
  ) {
    const active = this.active.get(daemonId);
    if (!active?.ready) return Promise.reject(new Error("daemon_not_connected"));
    if (!active.daemon.permissions.includes("hub.execute"))
      return Promise.reject(new Error("daemon_execution_not_allowed"));
    return active.agents.validate(agent);
  }

  updatePermissions(daemon: DaemonRecord): void {
    const active = this.active.get(daemon.id);
    if (active) active.daemon = daemon;
  }

  async revoke(daemon: DaemonRecord): Promise<void> {
    try {
      await Promise.all(Array.from(this.revokedHandlers, async (handler) => handler(daemon)));
    } finally {
      this.active.get(daemon.id)?.socket.close(4403, "revoked");
    }
  }

  async stop(): Promise<void> {
    const activeDaemons = Array.from(this.active.values());
    const sockets = activeDaemons.map(
      (active) =>
        new Promise<void>((resolve) => {
          if (active.socket.readyState === WebSocket.CLOSED) return resolve();
          active.socket.once("close", () => resolve());
          active.socket.close(1001, "server shutdown");
        }),
    );
    await Promise.all(sockets);
    await Promise.all(this.presenceWrites);
  }

  private receive(active: ActiveSocket, raw: string): void {
    if (this.active.get(active.daemon.id)?.generation !== active.generation) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      this.report(error, "daemon.websocket.message.parse", active.daemon.id, "validation");
      active.socket.close(4400, "invalid daemon message");
      return;
    }
    if (active.agents.receive(value)) return;
    const ready = ReadySchema.safeParse(value);
    if (!ready.success) {
      active.socket.close(4400, "invalid Miko execution protocol");
      return;
    }
    if (!samePermissions(ready.data.permissions, active.daemon.permissions)) {
      active.socket.close(4403, "daemon session permissions do not match enrollment");
      return;
    }
    this.markReady(active);
  }

  private markReady(active: ActiveSocket): void {
    if (active.ready) return;
    active.ready = true;
    const write = Promise.all([
      this.database.touchDaemon(active.daemon.id),
      this.database.setDaemonPresence(active.daemon.id, "connected"),
    ]).then(
      () => undefined,
      (error: unknown) => this.report(error, "daemon.presence.connected", active.daemon.id),
    );
    active.presenceReady = write;
    this.presenceWrites.add(write);
    void write.then(() => {
      this.presenceWrites.delete(write);
      for (const handler of this.connectedHandlers) {
        this.observeHandler(
          () => handler(active.daemon),
          "daemon.connected.handler",
          active.daemon.id,
        );
      }
      return undefined;
    });
  }

  private observeHandler(
    handler: () => void | Promise<void>,
    operation: string,
    daemonId: string,
    kind?: FailureKind,
    executionId?: string,
  ): void {
    void Promise.resolve()
      .then(handler)
      .catch((error: unknown) => this.report(error, operation, daemonId, kind, executionId));
  }

  private report(
    error: unknown,
    operation: string,
    daemonId: string,
    kind?: FailureKind,
    executionId?: string,
  ): void {
    reportFailure(
      error,
      {
        operation,
        component: "daemons",
        daemonId,
        ...(executionId === undefined ? {} : { executionId }),
      },
      { logger: this.failureLogger, ...(kind === undefined ? {} : { kind }) },
    );
  }
}

function samePermissions(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((permission) => actual.includes(permission))
  );
}

export function createDaemonUpgradeHandler(
  database: Pick<Database, "findDaemonById">,
  registry: ActiveDaemonRegistry,
) {
  const server = new WebSocketServer({ noServer: true });
  server.on("headers", (headers, request) => {
    if (request.headers[EXECUTION_PROTOCOL_HEADER] === EXECUTION_PROTOCOL_VERSION) {
      headers.push(`${EXECUTION_PROTOCOL_HEADER}: ${EXECUTION_PROTOCOL_VERSION}`);
    }
  });
  return async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/daemons/socket") {
      socket.destroy();
      return;
    }
    const daemonId = request.headers["x-paseo-daemon-id"];
    const credential = bearer(request.headers.authorization);
    if (typeof daemonId !== "string" || !credential) return rejectUpgrade(socket, 401);
    const daemon = await database.findDaemonById(daemonId);
    if (
      !daemon ||
      daemon.status !== "active" ||
      !matchesVerifier(credential, daemon.credentialVerifier)
    )
      return rejectUpgrade(socket, 403);
    if (request.headers[EXECUTION_PROTOCOL_HEADER] !== EXECUTION_PROTOCOL_VERSION)
      return rejectUpgrade(socket, 403);
    server.handleUpgrade(request, socket, head, (webSocket) => registry.accept(daemon, webSocket));
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
function matchesVerifier(value: string, verifier: string): boolean {
  const actual = Buffer.from(hash(value));
  const expected = Buffer.from(verifier);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function bearer(value: string | undefined): string | undefined {
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}
function rejectUpgrade(socket: Duplex, status: 401 | 403): void {
  socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function readText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  return data.toString();
}

export interface DaemonClock {
  nowDate(): Date;
}

const systemDaemonClock: DaemonClock = {
  nowDate: () => new Date(),
};
