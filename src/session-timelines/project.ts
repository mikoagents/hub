import type { TimelineRow } from "./store.js";

/** Project canonical chunks without dropping the original rows used by raw diagnostics. */
export function projectSessionRows(rows: readonly TimelineRow[]): TimelineRow[] {
  const result: TimelineRow[] = [];
  const tools = new Map<string, number>();
  for (const row of rows) {
    const item = row.item;
    const callId = typeof item["callId"] === "string" ? item["callId"] : null;
    if (item["type"] === "tool_call" && callId) {
      const index = tools.get(`${row.turnId ?? ""}:${callId}`);
      if (index !== undefined) {
        const old = result[index]!;
        result[index] = { ...old, item: { ...old.item, ...item } };
        continue;
      }
      tools.set(`${row.turnId ?? ""}:${callId}`, result.length);
    }
    const previous = result.at(-1);
    if (
      previous &&
      (item["type"] === "assistant_message" || item["type"] === "reasoning") &&
      previous.item["type"] === item["type"] &&
      previous.seq + 1 === row.seq &&
      previous.item["messageId"] === item["messageId"] &&
      previous.turnId === row.turnId &&
      typeof previous.item["text"] === "string" &&
      typeof item["text"] === "string"
    ) {
      result[result.length - 1] = {
        ...row,
        item: { ...item, text: previous.item["text"] + item["text"] },
      };
    } else result.push(row);
  }
  return result;
}
