import type { Database } from "../db/types.js";
import type { DaemonConnection } from "../daemons/protocol.js";
import { deriveAgentExecutionCompletionToken } from "../agent-executions/completion-token.js";
import { executionLogEvent } from "../daemons/execution-log.js";
import { TimelinePageSchema } from "../miko/protocol.js";

/** Reads only the session explicitly bound by Hub; native runtime IDs never become authority. */
export class SessionTimelines {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(
    private readonly database: Database,
    private readonly connectionForDaemon: (daemonId: string) => DaemonConnection | undefined,
    private readonly tokenSecret?: string,
  ) {}

  async sync(sessionId: string, before?: number): Promise<void> {
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.fetch(sessionId, before));
    this.pending.set(sessionId, operation);
    try {
      await operation;
    } finally {
      if (this.pending.get(sessionId) === operation) this.pending.delete(sessionId);
    }
  }

  private async fetch(sessionId: string, before?: number) {
    const session = await this.database.findAgentSession(sessionId);
    if (!session?.agentId || !session.runtimeBinding) throw new Error("session_unavailable");
    const connection = this.connectionForDaemon(session.daemonId);
    if (!connection) throw new Error("daemon_offline");
    const secrets =
      this.tokenSecret === undefined
        ? []
        : [
            deriveAgentExecutionCompletionToken(this.tokenSecret, `session:${sessionId}`),
            ...(await this.database.listAgentSessionExecutions(sessionId)).map((execution) =>
              deriveAgentExecutionCompletionToken(this.tokenSecret!, execution.id),
            ),
          ];
    let state = await this.database.sessionTimelines.state(sessionId);
    // Bound each synchronization. The next refresh resumes at the last saved sequence.
    for (let batch = 0; batch < 3; batch++) {
      let direction: "tail" | "after" | "before" = state ? "after" : "tail";
      if (before !== undefined) direction = "before";
      const page = await connection.agents.timeline(session.agentId, {
        limit: 200,
        direction,
        ...(state ? { cursor: { epoch: state.epoch, seq: before ?? state.endSeq } } : {}),
      });
      if (
        page.agent.nativeAgentId !== session.runtimeBinding.nativeAgentId ||
        page.agent.provider !== session.runtimeBinding.provider
      )
        throw new Error("session_binding_mismatch");
      const scrubbed = TimelinePageSchema.parse(executionLogEvent(page, secrets));
      await this.database.sessionTimelines.save(sessionId, scrubbed, state?.epoch ?? null);
      const next = await this.database.sessionTimelines.state(sessionId);
      if (before !== undefined || !page.hasNewer || next?.endSeq === state?.endSeq) return;
      state = next;
    }
  }

  async read(sessionId: string, before?: number) {
    let availability: "connected" | "offline" | "unavailable" = "connected";
    let unavailableReason: string | null = null;
    try {
      await this.sync(sessionId, before);
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      availability = code === "daemon_offline" ? "offline" : "unavailable";
      unavailableReason = HISTORY_FAILURES[code] ?? "Hub couldn't refresh this session history.";
    }
    const state = await this.database.sessionTimelines.state(sessionId);
    const rows = await this.database.sessionTimelines.rows(sessionId, before);
    const first = rows[0]?.seq;
    return {
      state: state ?? null,
      rows,
      availability,
      unavailableReason,
      hasOlder:
        state !== undefined && (state.hasOlder || (first !== undefined && first > state.startSeq)),
    };
  }
}

const HISTORY_FAILURES: Record<string, string> = {
  daemon_offline: "The execution daemon is offline.",
  session_unavailable: "This execution has no readable session reference.",
  session_history_unavailable: "The provider no longer retains this session's history.",
  session_not_found: "The execution daemon could not find this session.",
  session_binding_mismatch: "The daemon returned a different session reference.",
  execution_not_allowed: "The daemon no longer grants Hub access to this session.",
};
