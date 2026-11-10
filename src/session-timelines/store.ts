import type { DatabaseRuntime } from "../db/runtime/index.js";
import type { TimelinePage } from "../miko/protocol.js";

export type TimelineRow = TimelinePage["rows"][number];
export interface TimelineState extends Omit<TimelinePage, "rows" | "reset" | "window"> {
  startSeq: number;
  endSeq: number;
  updatedAt: string;
}
export interface SessionTimelineStore {
  state(sessionId: string): Promise<TimelineState | undefined>;
  save(sessionId: string, page: TimelinePage, expectedEpoch?: string | null): Promise<void>;
  rows(sessionId: string, before?: number): Promise<TimelineRow[]>;
}

function mergeState(previous: TimelineState | undefined, page: TimelinePage): TimelineState {
  const old = previous?.epoch === page.epoch && !page.reset ? previous : undefined;
  const first = page.rows[0]?.seq ?? 0;
  const last = page.rows.at(-1)?.seq ?? 0;
  const startSeq = old && old.startSeq > 0 ? Math.min(old.startSeq, first || old.startSeq) : first;
  const endSeq = Math.max(old?.endSeq ?? 0, last);
  return {
    epoch: page.epoch,
    startSeq,
    endSeq,
    hasOlder: old && (first === 0 || first > old.startSeq) ? old.hasOlder : page.hasOlder,
    hasNewer: endSeq < page.window.maxSeq,
    agent: page.agent,
    updatedAt: new Date().toISOString(),
  };
}

export class PgSessionTimelineStore implements SessionTimelineStore {
  constructor(private readonly runtime: DatabaseRuntime) {}
  async state(sessionId: string) {
    const result = await this.runtime.query<{ data: TimelineState }>(
      "select data from agent_session_timelines where session_id = $1",
      [sessionId],
    );
    return result.rows[0]?.data;
  }
  async save(sessionId: string, page: TimelinePage, expectedEpoch?: string | null) {
    await this.runtime.transaction(async (transaction) => {
      await transaction.query(
        "insert into agent_session_timelines (session_id, data) values ($1, '{}'::jsonb) on conflict do nothing",
        [sessionId],
      );
      const existing = await transaction.query<{ data: TimelineState }>(
        "select data from agent_session_timelines where session_id = $1 for update",
        [sessionId],
      );
      const previous = existing.rows[0]?.data;
      if (
        expectedEpoch !== undefined &&
        (previous?.epoch ?? null) !== expectedEpoch &&
        previous?.epoch !== page.epoch
      )
        return;

      if (previous?.epoch !== page.epoch || page.reset)
        await transaction.query("delete from agent_session_timeline_rows where session_id = $1", [
          sessionId,
        ]);
      const state = mergeState(previous, page);
      await transaction.query(
        "update agent_session_timelines set data = $2 where session_id = $1",
        [sessionId, state],
      );
      if (page.rows.length > 0)
        await transaction.query(
          `insert into agent_session_timeline_rows (session_id, seq, data)
           select $1, (item->>'seq')::integer, item from jsonb_array_elements($2::jsonb) as item
           on conflict (session_id, seq) do update set data = excluded.data`,
          [sessionId, JSON.stringify(page.rows)],
        );
    });
  }
  async rows(sessionId: string, before?: number) {
    const result = await this.runtime.query<{ data: TimelineRow }>(
      `select data from agent_session_timeline_rows where session_id = $1 and seq < $2 order by seq desc limit 200`,
      [sessionId, before ?? 2147483647],
    );
    return result.rows.map(({ data }) => data).toReversed();
  }
}

export class MemorySessionTimelineStore implements SessionTimelineStore {
  private readonly states = new Map<string, TimelineState>();
  private readonly entries = new Map<string, Map<number, TimelineRow>>();
  async state(sessionId: string) {
    return this.states.get(sessionId);
  }
  async save(sessionId: string, page: TimelinePage, expectedEpoch?: string | null) {
    const old = this.states.get(sessionId);
    if (
      expectedEpoch !== undefined &&
      (old?.epoch ?? null) !== expectedEpoch &&
      old?.epoch !== page.epoch
    )
      return;
    const rows =
      old?.epoch === page.epoch && !page.reset
        ? (this.entries.get(sessionId) ?? new Map<number, TimelineRow>())
        : new Map<number, TimelineRow>();
    for (const row of page.rows) rows.set(row.seq, row);
    this.entries.set(sessionId, rows);
    this.states.set(sessionId, mergeState(old, page));
  }
  async rows(sessionId: string, before?: number) {
    return [...(this.entries.get(sessionId)?.values() ?? [])]
      .filter((row) => before === undefined || row.seq < before)
      .sort((a, b) => a.seq - b.seq)
      .slice(-200);
  }
}
