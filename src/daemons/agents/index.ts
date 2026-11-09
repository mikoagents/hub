import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  EXECUTION_PROTOCOL_VERSION as version,
  RequestSchema,
  ResponseSchema,
  EventSchema,
  AgentSnapshotSchema,
  ProviderSnapshotSchema,
  ValidationResultSchema,
  type ExecutionRequest,
  type AgentEvent,
} from "../../miko/protocol.js";
import type { DaemonCreateAgentOptions } from "../protocol.js";
import { DaemonResponseLostError } from "../protocol.js";
export type { AgentSnapshot, AgentEvent } from "../../miko/protocol.js";
export interface AgentConnection {
  create(
    key: string,
    options: DaemonCreateAgentOptions,
    timeoutMs?: number,
  ): Promise<import("../../miko/protocol.js").AgentSnapshot>;
  get(agentId: string): Promise<import("../../miko/protocol.js").AgentSnapshot>;
  send(agentId: string, messageId: string, text: string, timeoutMs?: number): Promise<void>;
  restore(workspaceId: string, timeoutMs?: number, key?: string): Promise<boolean>;
  control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
    key?: string,
  ): Promise<void>;
  watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void>;
}
export class DaemonAgentError extends Error {}
/** Hub speaks only the public execution protocol. Native RPC translation lives in Miko. */
export class DaemonAgents implements AgentConnection {
  private readonly pending = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private readonly workspaces = new Map<string, string>();
  private closed = false;
  constructor(
    private readonly sendFrame: (frame: string) => void,
    private readonly now: () => Date = () => new Date(),
    private readonly reportFailure: (error: unknown, operation: string) => void = () => {},
  ) {}
  receive(value: unknown): boolean {
    const response = ResponseSchema.safeParse(value);
    if (response.success) {
      const pending = this.pending.get(response.data.requestId);
      if (!pending) return true;
      if (response.data.error)
        pending.reject(
          response.data.error.code === "request_outcome_unknown"
            ? new DaemonResponseLostError()
            : new DaemonAgentError(response.data.error.code),
        );
      else pending.resolve(response.data.result);
      return true;
    }
    const event = EventSchema.safeParse(value);
    if (!event.success) return false;
    const data = event.data.event,
      agentId = data.type === "agent_stream" ? data.agentId : data.agent.id;
    for (const listener of this.listeners.get(agentId) ?? [])
      listener({ ...data, timestamp: this.now().toISOString() });
    return true;
  }
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new DaemonResponseLostError());
    this.pending.clear();
    this.listeners.clear();
  }
  async create(key: string, options: DaemonCreateAgentOptions, timeoutMs?: number) {
    const agent = AgentSnapshotSchema.parse(
      await this.durable("create", { key, options }, `create:${key}`, timeoutMs),
    );
    this.workspaces.set(agent.workspaceId, agent.id);
    return agent;
  }
  async get(agentId: string) {
    const agent = AgentSnapshotSchema.parse(await this.request("get", { agentId }));
    this.workspaces.set(agent.workspaceId, agent.id);
    return agent;
  }
  async send(agentId: string, messageId: string, text: string, timeoutMs?: number): Promise<void> {
    await this.durable(
      "submit",
      { agentId, messageId, text },
      `submit:${agentId}:${messageId}`,
      timeoutMs,
    );
  }
  async restore(workspaceId: string, timeoutMs?: number, key?: string): Promise<boolean> {
    const agentId = this.workspaces.get(workspaceId);
    if (!agentId) throw new DaemonAgentError("session_binding_missing");
    const result = await this.request(
      "restore",
      { agentId, workspaceId, key: key ?? randomUUID() },
      timeoutMs,
    );
    if (typeof result !== "boolean") throw new DaemonAgentError("invalid_restore_result");
    return result;
  }
  async control(
    agentId: string,
    workspaceId: string,
    action: "interrupt" | "archive",
    key?: string,
  ): Promise<void> {
    await this.request(action === "interrupt" ? "cancel" : "cleanup", {
      agentId,
      workspaceId,
      key: key ?? randomUUID(),
    });
  }
  async watch(agentId: string, listener: (event: AgentEvent) => void): Promise<() => void> {
    const listeners = this.listeners.get(agentId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(agentId, listeners);
    try {
      await this.request("watch", { agentId });
    } catch (error) {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(agentId);
      throw error;
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.listeners.delete(agentId);
        if (!this.closed)
          void this.request("unwatch", { agentId }).catch((error) => {
            if (!(error instanceof DaemonResponseLostError))
              this.reportFailure(error, "miko.unwatch");
          });
      }
    };
  }
  async providers(options: { cwd?: string; backend?: string }) {
    return ProviderSnapshotSchema.parse(await this.request("providers", options));
  }
  async refresh(options: { cwd?: string; backend?: string; providers?: string[] }): Promise<void> {
    await this.request("refresh", options);
  }
  async validate(agent: import("../../config/compiler.js").CompiledAgent) {
    const { options, ...rest } = agent;
    return ValidationResultSchema.parse(
      await this.request("validate", { ...rest, providerOptions: options }),
    );
  }
  private async durable(
    operation: "create" | "submit",
    input: Record<string, unknown>,
    key: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    const receipt = await this.request("receipt", { key });
    const parsed = importReceipt(receipt);
    if (parsed?.state === "completed") {
      // Send again with the same semantic key so Miko validates its fingerprint before replay.
      return this.request(operation, input, timeoutMs);
    }
    if (parsed?.state === "pending" && operation === "submit") throw new DaemonResponseLostError();
    try {
      return await this.request(operation, input, timeoutMs);
    } catch (error) {
      if (!(error instanceof DaemonResponseLostError)) throw error;
      // A lost transport is recoverable only by consulting the original durable receipt.
      const recovered = importReceipt(await this.request("receipt", { key }));
      if (recovered?.state === "completed") return recovered.result;
      throw error;
    }
  }
  async request(
    operation: ExecutionRequest["operation"],
    input: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.closed) throw new DaemonResponseLostError();
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        timer = setTimeout(() => reject(new DaemonResponseLostError()), timeoutMs);
        this.sendFrame(
          JSON.stringify(
            RequestSchema.parse({ type: "miko.request", version, requestId, operation, input }),
          ),
        );
      });
    } finally {
      clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }
}

function importReceipt(value: unknown) {
  return z
    .object({ state: z.enum(["pending", "completed"]), result: z.unknown().optional() })
    .nullable()
    .parse(value);
}
