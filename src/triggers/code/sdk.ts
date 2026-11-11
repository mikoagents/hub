/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Generic results follow the author contract; Hub validates JSON and declared agent schemas. */
/** The author-facing Trigger SDK. This module has no Hub/server side effects. */
import { durableJson } from "./sdk-json.js";
import { createGitHubClient, type TriggerGitHub } from "./sdk-github.js";
import { errorFailure, operationError, type TriggerFailure } from "./sdk-errors.js";

export { stableJson } from "./sdk-json.js";
export { GitHubRequestError, TriggerOperationError } from "./sdk-errors.js";
export type { TriggerFailure } from "./sdk-errors.js";
export { githubIssueComment } from "./sdk-github.js";
export type {
  TriggerGitHub,
  GitHubRepository,
  GitHubRequest,
  GitHubResponse,
  GitHubReadOptions,
  GitHubListOptions,
  GitHubCommentReceipt,
  PublishGitHubCommentOptions,
  FindGitHubCommentOptions,
  GitHubIssue,
  GitHubComment,
  GitHubPull,
  GitHubFile,
  GitHubReview,
  GitHubReviewComment,
  GitHubWorkflow,
  GitHubCheck,
  GitHubStatus,
  GitHubCommit,
  GitHubPermission,
} from "./sdk-github.js";
export type TriggerValue =
  | null
  | boolean
  | number
  | string
  | TriggerValue[]
  | { [key: string]: TriggerValue };

export interface TriggerEvent {
  id: string;
  source: string;
  type: string;
  receivedAt: string;
  connection?: string | undefined;
  resource?: string | undefined;
  payload: TriggerValue;
}

export interface TriggerSubscription {
  source: string;
  event: string | string[];
  connection?: string | undefined;
  resource?: string | undefined;
  /** Existing Hub recurrence contract, including its IANA timezone. */
  recurrence?: import("../schedule/recurrence.js").Recurrence | undefined;
}

export interface TriggerGrants {
  /** Target aliases are the only daemons and directories code can dispatch to. */
  targets?:
    | Record<
        string,
        {
          daemon: string;
          cwd: string;
          providers: string[];
          env?: Record<string, string> | undefined;
        }
      >
    | undefined;
  github?:
    | Record<
        string,
        {
          connection: string;
          repositories: string[];
          permissions: Record<string, "read" | "write" | "admin">;
        }
      >
    | undefined;
  /** Names explicitly provided by the runner operator. Never the Hub environment. */
  secrets?: string[] | undefined;
}

export interface TriggerManifest {
  name: string;
  description?: string | undefined;
  /** Optional Pele diagram in Mermaid syntax, including mindmaps. Documentation only; code controls execution. */
  diagram?: string | undefined;
  on: TriggerSubscription[];
  runner: string;
  grants: TriggerGrants;
  limits: { maxRuntime: string; maxAgentRuns?: number | undefined };
}

export interface TriggerAgentOptions {
  target: string;
  agent: {
    provider: string;
    model?: string;
    mode?: string;
    thinkingOptionId?: string;
    options?: Record<string, TriggerValue>;
  };
  prompt: string;
  maxRuntime: string;
  idleTimeout: string;
  startupTimeout?: string;
  title?: string;
  env?: Record<string, string> | undefined;
  github?: string;
  worktree?:
    | { mode: "branch-off"; newBranch: string; base?: string }
    | { mode: "checkout-branch"; branch: string }
    | { mode: "checkout-pr"; prNumber: number };
  continuation?: { key: string };
  output?: { schema: Record<string, unknown> };
  outputs?: Record<string, { required?: boolean; max?: number }>;
  autoArchive?: boolean;
  background?: boolean;
}

export interface TriggerAgentResult<T = TriggerValue> {
  runId: string;
  executionId: string | null;
  output: T;
}

export interface TriggerContext {
  readonly runId: string;
  readonly event: TriggerEvent;
  readonly deadlineAt: string;
  /** Stable workflow time. Put nondeterministic I/O inside step(). */
  readonly startedAt: string;
  step<I, O>(id: string, input: I, action: (input: I) => O | Promise<O>): Promise<O>;
  agent: {
    run<T = TriggerValue>(id: string, options: TriggerAgentOptions): Promise<TriggerAgentResult<T>>;
  };
  sleep(id: string, milliseconds: number): Promise<void>;
  waitForEvent(
    id: string,
    options: {
      source: string;
      event: string | string[];
      timeout: string;
      where?: (event: TriggerEvent) => boolean;
    },
  ): Promise<TriggerEvent>;
  claim(key: string): Promise<boolean>;
  withLock<T>(id: string, key: string, action: () => T | Promise<T>): Promise<T>;
  state: {
    get<T = TriggerValue>(id: string, key: string): Promise<T | null>;
    set(id: string, key: string, value: unknown): Promise<void>;
    delete(id: string, key: string): Promise<void>;
  };
  github: TriggerGitHub;
  secret(name: string): string;
  log(message: string, data?: TriggerValue): Promise<void>;
  skip(reason: string): never;
}

export interface TriggerDefinition extends TriggerManifest {
  run(context: TriggerContext): unknown;
}

export function defineTrigger<T extends TriggerDefinition>(definition: T): T {
  return definition;
}

export interface OperationRequest {
  id: string;
  kind: string;
  input: unknown;
}
export type OperationReply =
  | { status: "completed"; output: unknown }
  | { status: "execute" }
  | { status: "waiting" }
  | { status: "failed"; error: string; failure?: TriggerFailure };

export interface TriggerTransport {
  operation(request: OperationRequest): Promise<OperationReply>;
  complete(
    id: string,
    result: { output: unknown } | { error: string; failure?: TriggerFailure },
  ): Promise<void>;
  log(message: string, data?: TriggerValue): Promise<void>;
}

export class TriggerSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TriggerSkipped";
  }
}

/** Runtime hook shared by the runner and deterministic SDK tests. */
export function createTriggerContext(input: {
  runId: string;
  event: TriggerEvent;
  deadlineAt: string;
  startedAt: string;
  transport: TriggerTransport;
  secrets: Readonly<Record<string, string>>;
  onWaiting?: () => void;
}) {
  let requests = 0;
  let activities = 0;
  let waiting = 0;
  let automaticId = 0;
  const local = new Set<Promise<unknown>>();
  const waitingIds = new Set<string>();
  const changed = () => {
    queueMicrotask(() => {
      if (requests === 0 && activities === 0 && waiting > 0) input.onWaiting?.();
    });
  };
  async function operation<T>(id: string, kind: string, value: unknown): Promise<T> {
    requests++;
    let reply: OperationReply;
    try {
      reply = await input.transport.operation({ id, kind, input: value });
    } finally {
      requests--;
    }
    if (reply.status === "failed") throw operationError(reply.error, reply.failure, id);
    if (reply.status === "waiting") {
      waiting++;
      waitingIds.add(id);
      changed();
      // Suspending the worker never throws into the author's try/catch blocks.
      return await new Promise<T>(() => {});
    }
    if (reply.status === "execute") throw new Error(`Unexpected local operation: ${kind}`);
    changed();
    return durableJson(reply.output) as T;
  }
  const context: TriggerContext = {
    runId: input.runId,
    event: durableJson(input.event) as TriggerEvent,
    deadlineAt: input.deadlineAt,
    startedAt: input.startedAt,
    async step<I, O>(id: string, value: I, action: (value: I) => O | Promise<O>): Promise<O> {
      requests++;
      let reply: OperationReply;
      try {
        reply = await input.transport.operation({ id, kind: "step", input: value });
      } finally {
        requests--;
      }
      if (reply.status === "failed") throw operationError(reply.error, reply.failure, id);
      if (reply.status === "completed") {
        changed();
        return durableJson(reply.output) as O;
      }
      if (reply.status !== "execute")
        throw new Error("A local step cannot wait for another runner");
      activities++;
      const task = (async () => {
        try {
          const result = await action(value);
          const output = durableJson(result === undefined ? null : result);
          await input.transport.complete(id, { output });
          return output as O;
        } catch (error) {
          await input.transport.complete(id, {
            error: error instanceof Error ? error.message : String(error),
            ...(errorFailure(error) === undefined ? {} : { failure: errorFailure(error)! }),
          });
          throw error;
        } finally {
          activities--;
          changed();
        }
      })();
      local.add(task);
      try {
        return await task;
      } finally {
        local.delete(task);
      }
    },
    agent: { run: (id, options) => operation(id, "agent", options) },
    sleep: async (id, milliseconds) => {
      await operation(id, "sleep", { milliseconds });
    },
    async waitForEvent(id, options) {
      const { where, ...subscription } = options;
      let cursor = 0;
      for (;;) {
        const result = await operation<{ cursor: number; event: TriggerEvent }>(
          `${id}:${cursor}`,
          "event",
          { ...subscription, cursor, group: id },
        );
        if (where === undefined || where(result.event)) return result.event;
        cursor = result.cursor;
      }
    },
    claim: (key) => operation(`claim:${automaticId++}`, "claim", { key }),
    async withLock<T>(id: string, key: string, action: () => T | Promise<T>): Promise<T> {
      await operation(`${id}:acquire`, "lock", { key });
      // A durable lock remains owned while the workflow is suspended.
      const result = await action();
      await operation(`${id}:release`, "unlock", { key });
      return result;
    },
    state: {
      get: (id, key) => operation(id, "state.get", { key }),
      set: async (id, key, value) => {
        await operation(id, "state.set", { key, value });
      },
      delete: async (id, key) => {
        await operation(id, "state.delete", { key });
      },
    },
    github: createGitHubClient({
      request: (id, grant, request) => operation(id, "github", { grant, ...request }),
      sleep: (id, milliseconds) => context.sleep(id, milliseconds),
      withLock: (id, key, action) => context.withLock(id, key, action),
    }),
    secret(name) {
      const value = Object.hasOwn(input.secrets, name) ? input.secrets[name] : undefined;
      if (value === undefined)
        throw new Error(`Runner secret is not granted or configured: ${name}`);
      return value;
    },
    log: (message, data) => input.transport.log(message, data),
    skip(reason): never {
      throw new TriggerSkipped(reason);
    },
  };
  return {
    context,
    drain: () => Promise.allSettled(local),
    isWaiting: () => waiting > 0 && requests === 0 && activities === 0,
    waitingOperations: () => [...waitingIds],
  };
}
