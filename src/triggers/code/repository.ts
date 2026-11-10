/* oxlint-disable oxc/no-map-spread -- In-memory transaction snapshots must not mutate the previously committed state. */
import type { DatabaseRuntime, QueryHandle } from "../../db/runtime/index.js";
import type { Locks } from "../../db/runtime/locks/index.js";
import type {
  CodeRun,
  CodeOperation,
  CodeState,
  CodeEvent,
  CodeLog,
  CodeRunner,
  TriggerCodeRepository,
  TriggerCodeTransaction,
} from "./records.js";

/** All short mutations serialize per organization; no network work holds this transaction. */
export class PgTriggerCodeRepository implements TriggerCodeRepository {
  constructor(
    private readonly runtime: DatabaseRuntime,
    private readonly locks: Locks,
  ) {}
  transaction<T>(
    organizationId: string,
    operation: (transaction: TriggerCodeTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runtime.transaction(async (client) => {
      await this.locks.withTxLock(client, `trigger-code:${organizationId}`);
      return operation(new PgCodeTransaction(client, organizationId));
    });
  }
  async runnerByHash(hash: string): Promise<CodeRunner | undefined> {
    return (
      await this.runtime.query<{ document: CodeRunner }>(
        "select document from trigger_code_runners where token_hash = $1",
        [hash],
      )
    ).rows[0]?.document;
  }
  async organizations(): Promise<string[]> {
    return (
      await this.runtime.query<{ organization_id: string }>(
        "select distinct organization_id from organization_triggers where format='code' union select distinct organization_id from trigger_code_runs where status in ('queued', 'running', 'waiting')",
      )
    ).rows.map((row) => row.organization_id);
  }
}

class PgCodeTransaction implements TriggerCodeTransaction {
  constructor(
    private readonly client: QueryHandle,
    private readonly organizationId: string,
  ) {}
  async getRun(id: string) {
    return (
      await this.client.query<{ document: CodeRun }>(
        "select document from trigger_code_runs where organization_id = $1 and id = $2",
        [this.organizationId, id],
      )
    ).rows[0]?.document;
  }
  async putRun(run: CodeRun) {
    if (run.organizationId !== this.organizationId)
      throw new Error("Trigger run organization mismatch");
    await this.client.query(
      `insert into trigger_code_runs (id, organization_id, trigger_id, revision_id, status, created_at, document)
      values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do update set status=excluded.status, document=excluded.document`,
      [run.id, this.organizationId, run.triggerId, run.revisionId, run.status, run.createdAt, run],
    );
  }
  async listRuns(triggerId?: string, limit = 200) {
    return (
      await this.client.query<{ document: CodeRun }>(
        `select document from trigger_code_runs where organization_id = $1 and ($2::uuid is null or trigger_id = $2) order by created_at desc, id desc limit $3`,
        [this.organizationId, triggerId ?? null, limit],
      )
    ).rows.map((row) => row.document);
  }
  async activeRuns(after?: string) {
    return (
      await this.client.query<{ document: CodeRun }>(
        "select document from trigger_code_runs where organization_id=$1 and (status in ('queued','running','waiting') or document->>'cleanupPending'='true') and ($2::uuid is null or id>$2) order by id limit 100",
        [this.organizationId, after ?? null],
      )
    ).rows.map((row) => row.document);
  }
  async nextQueuedRun(runner: string) {
    return (
      await this.client.query<{ document: CodeRun }>(
        "select document from trigger_code_runs where organization_id=$1 and status='queued' and document->>'runner'=$2 order by created_at,id limit 1",
        [this.organizationId, runner],
      )
    ).rows[0]?.document;
  }
  async activeRevisions(triggerId: string) {
    return (
      await this.client.query<{ revision_id: string }>(
        "select distinct revision_id from trigger_code_runs where organization_id=$1 and trigger_id=$2 and status in ('queued','running','waiting')",
        [this.organizationId, triggerId],
      )
    ).rows.map((row) => row.revision_id);
  }
  async runForEvent(triggerId: string, event: CodeEvent["event"]) {
    return (
      await this.client.query<{ document: CodeRun }>(
        "select document from trigger_code_runs where organization_id=$1 and trigger_id=$2 and document->'event'->>'id'=$3 and document->'event'->>'source'=$4 limit 1",
        [this.organizationId, triggerId, event.id, event.source],
      )
    ).rows[0]?.document;
  }
  async getOperation(runId: string, id: string) {
    return (
      await this.client.query<{ document: CodeOperation }>(
        "select document from trigger_code_operations where organization_id=$1 and run_id=$2 and operation_id=$3",
        [this.organizationId, runId, id],
      )
    ).rows[0]?.document;
  }
  async putOperation(operation: CodeOperation) {
    await this.client.query(
      `insert into trigger_code_operations (organization_id, run_id, operation_id, created_at, document) values ($1,$2,$3,$4,$5)
      on conflict (run_id,operation_id) do update set document=excluded.document`,
      [this.organizationId, operation.runId, operation.id, operation.createdAt, operation],
    );
  }
  async operations(runId: string) {
    return (
      await this.client.query<{ document: CodeOperation }>(
        "select document from trigger_code_operations where organization_id=$1 and run_id=$2 order by created_at, operation_id",
        [this.organizationId, runId],
      )
    ).rows.map((row) => row.document);
  }
  async appendEvent(triggerId: string, event: CodeEvent["event"]) {
    const result = await this.client.query(
      "insert into trigger_code_events (organization_id, trigger_id, delivery_id, received_at, document) values ($1,$2,$3,$4,$5) on conflict (trigger_id,delivery_id) do nothing returning sequence",
      [this.organizationId, triggerId, `${event.source}:${event.id}`, event.receivedAt, event],
    );
    return result.rows.length > 0;
  }
  async events(triggerId: string, after: number, since: string) {
    return (
      await this.client.query<{ sequence: string; document: CodeEvent["event"] }>(
        "select sequence, document from trigger_code_events where organization_id=$1 and trigger_id=$2 and sequence>$3 and received_at >= $4 order by sequence limit 500",
        [this.organizationId, triggerId, after, since],
      )
    ).rows.map((row) => ({ sequence: Number(row.sequence), triggerId, event: row.document }));
  }
  async getState(triggerId: string, kind: CodeState["kind"], key: string) {
    return (
      await this.client.query<{ document: CodeState }>(
        "select document from trigger_code_state where organization_id=$1 and trigger_id=$2 and kind=$3 and state_key=$4",
        [this.organizationId, triggerId, kind, key],
      )
    ).rows[0]?.document;
  }
  async putState(triggerId: string, state: CodeState) {
    await this.client.query(
      `insert into trigger_code_state (organization_id, trigger_id, kind, state_key, owner_run_id, document) values ($1,$2,$3,$4,$5,$6) on conflict (trigger_id,kind,state_key) do update set owner_run_id=excluded.owner_run_id, document=excluded.document`,
      [this.organizationId, triggerId, state.kind, state.key, state.ownerRunId, state],
    );
  }
  async deleteState(triggerId: string, kind: CodeState["kind"], key: string) {
    await this.client.query(
      "delete from trigger_code_state where organization_id=$1 and trigger_id=$2 and kind=$3 and state_key=$4",
      [this.organizationId, triggerId, kind, key],
    );
  }
  async releaseLocks(runId: string) {
    await this.client.query(
      "delete from trigger_code_state where organization_id=$1 and kind='lock' and owner_run_id=$2",
      [this.organizationId, runId],
    );
  }
  async putRunner(runner: CodeRunner) {
    if (runner.organizationId !== this.organizationId)
      throw new Error("Runner organization mismatch");
    await this.client.query(
      "insert into trigger_code_runners (id,organization_id,name,token_hash,document) values ($1,$2,$3,$4,$5) on conflict (organization_id,name) do update set token_hash=excluded.token_hash, document=excluded.document",
      [runner.id, this.organizationId, runner.name, runner.tokenHash, runner],
    );
  }
  async log(log: CodeLog) {
    await this.client.query(
      "insert into trigger_code_logs (id,organization_id,run_id,created_at,document) values ($1,$2,$3,$4,$5) on conflict (id) do nothing",
      [log.id, this.organizationId, log.runId, log.time, log],
    );
  }
  async logs(runId: string, limit = 200) {
    return (
      await this.client.query<{ document: CodeLog }>(
        "select document from (select created_at, id, document from trigger_code_logs where organization_id=$1 and run_id=$2 order by created_at desc,id desc limit $3) recent order by created_at,id",
        [this.organizationId, runId, limit],
      )
    ).rows.map((row) => row.document);
  }
}

export class MemoryTriggerCodeRepository implements TriggerCodeRepository {
  private readonly documents = new Map<
    string,
    {
      runs: Map<string, CodeRun>;
      operations: Map<string, CodeOperation>;
      events: CodeEvent[];
      state: Map<string, CodeState>;
      runners: Map<string, CodeRunner>;
      logs: CodeLog[];
    }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  transaction<T>(
    organizationId: string,
    operation: (transaction: TriggerCodeTransaction) => Promise<T>,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const original = this.documents.get(organizationId) ?? {
        runs: new Map<string, CodeRun>(),
        operations: new Map<string, CodeOperation>(),
        events: [] as CodeEvent[],
        state: new Map<string, CodeState>(),
        runners: new Map<string, CodeRunner>(),
        logs: [] as CodeLog[],
      };
      const data = structuredClone(original);
      const transaction: TriggerCodeTransaction = {
        getRun: async (id) => data.runs.get(id),
        putRun: async (value) => {
          if (value.organizationId !== organizationId)
            throw new Error("Trigger run organization mismatch");
          data.runs.set(value.id, value);
        },
        listRuns: async (triggerId, limit = 200) =>
          [...data.runs.values()]
            .filter((item) => triggerId === undefined || item.triggerId === triggerId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, limit),
        activeRuns: async (after) =>
          [...data.runs.values()]
            .filter(
              (item) =>
                (["queued", "running", "waiting"].includes(item.status) || item.cleanupPending) &&
                (after === undefined || item.id > after),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, 100),
        nextQueuedRun: async (runner) =>
          [...data.runs.values()]
            .filter((item) => item.runner === runner && item.status === "queued")
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0],
        activeRevisions: async (triggerId) => [
          ...new Set(
            [...data.runs.values()]
              .filter(
                (item) =>
                  item.triggerId === triggerId &&
                  ["queued", "running", "waiting"].includes(item.status),
              )
              .map((item) => item.revisionId),
          ),
        ],
        runForEvent: async (triggerId, event) =>
          [...data.runs.values()].find(
            (item) =>
              item.triggerId === triggerId &&
              item.event.id === event.id &&
              item.event.source === event.source,
          ),
        getOperation: async (runId, id) => data.operations.get(`${runId}\0${id}`),
        putOperation: async (value) => {
          data.operations.set(`${value.runId}\0${value.id}`, value);
        },
        operations: async (runId) =>
          [...data.operations.values()].filter((item) => item.runId === runId),
        appendEvent: async (triggerId, event) => {
          if (
            data.events.some(
              (item) =>
                item.triggerId === triggerId &&
                item.event.id === event.id &&
                item.event.source === event.source,
            )
          )
            return false;
          data.events.push({ sequence: ++this.sequence, triggerId, event });
          return true;
        },
        events: async (triggerId, after, since) =>
          data.events
            .filter(
              (item) =>
                item.triggerId === triggerId &&
                item.sequence > after &&
                item.event.receivedAt >= since,
            )
            .slice(0, 500),
        getState: async (triggerId, kind, key) => data.state.get(`${triggerId}\0${kind}\0${key}`),
        putState: async (triggerId, value) => {
          data.state.set(`${triggerId}\0${value.kind}\0${value.key}`, value);
        },
        deleteState: async (triggerId, kind, key) => {
          data.state.delete(`${triggerId}\0${kind}\0${key}`);
        },
        releaseLocks: async (runId) => {
          for (const [key, value] of data.state)
            if (value.kind === "lock" && value.ownerRunId === runId) data.state.delete(key);
        },
        putRunner: async (value) => {
          data.runners.set(value.name, value);
        },
        log: async (value) => {
          if (!data.logs.some((log) => log.id === value.id)) data.logs.push(value);
        },
        logs: async (runId, limit = 200) =>
          data.logs.filter((item) => item.runId === runId).slice(-limit),
      };
      const result = await operation(transaction);
      this.documents.set(organizationId, data);
      return structuredClone(result);
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async runnerByHash(hash: string) {
    return structuredClone(
      [...this.documents.values()]
        .flatMap((data) => [...data.runners.values()])
        .find((runner) => runner.tokenHash === hash),
    );
  }
  async organizations() {
    return [...this.documents.keys()];
  }
}
