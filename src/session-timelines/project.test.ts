import { expect, test } from "vitest";
import { projectSessionRows } from "./project.js";
import type { TimelineRow } from "./store.js";

test("renders tool lifecycles once and joins adjacent message chunks without crossing turns", () => {
  const rows: TimelineRow[] = [
    {
      seq: 1,
      timestamp: "now",
      turnId: "one",
      item: { type: "assistant_message", text: "Reading " },
    },
    {
      seq: 2,
      timestamp: "now",
      turnId: "one",
      item: { type: "assistant_message", text: "source" },
    },
    {
      seq: 3,
      timestamp: "now",
      turnId: "one",
      item: { type: "tool_call", callId: "call", name: "read", status: "running" },
    },
    {
      seq: 4,
      timestamp: "now",
      turnId: "one",
      item: { type: "tool_call", callId: "call", status: "completed", detail: { output: "file" } },
    },
    {
      seq: 5,
      timestamp: "now",
      turnId: "two",
      item: { type: "assistant_message", text: "Next turn" },
    },
    {
      seq: 6,
      timestamp: "now",
      turnId: "two",
      item: { type: "tool_call", callId: "call", status: "running" },
    },
  ];
  const projected = projectSessionRows(rows);
  expect(projected).toHaveLength(4);
  expect(projected[0]?.item["text"]).toBe("Reading source");
  expect(projected[1]?.item).toMatchObject({
    name: "read",
    status: "completed",
    detail: { output: "file" },
  });
  expect(projected[3]?.item["status"]).toBe("running");
  expect(rows[2]?.item["status"]).toBe("running");
});
