/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- shared transcript surfaces accept composed facts */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { TimelineRow } from "../../session-timelines/store.js";
import type { JsonValue } from "../../config/compiler.js";
import { projectSessionRows } from "../../session-timelines/project.js";
import { Button } from "../ui/button.js";
import { cn } from "../../lib/utils.js";
import { CodeBlock, CopyButton } from "./copy-field.js";
import { Disclosure } from "./disclosure.js";
import { RelativeTime } from "./relative-time.js";
import { StatusPill } from "./status-pill.js";
import { Section } from "./section.js";

export function SessionTranscript({ rows }: { rows: readonly TimelineRow[] }) {
  return (
    <ol className="grid min-w-0 gap-4" aria-label="Session messages">
      {projectSessionRows(rows).map((row) => (
        <li key={row.seq} className="min-w-0">
          <TranscriptEntry row={row} />
        </li>
      ))}
    </ol>
  );
}

function string(value: JsonValue | undefined, fallback: string) {
  return typeof value === "string" ? value : fallback;
}
function content(value: JsonValue) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function statusTone(status: string) {
  if (status === "failed") return "danger";
  if (status === "completed") return "success";
  return "neutral";
}
function TranscriptEntry({ row }: { row: TimelineRow }) {
  if (row.item["type"] === "tool_call") return <ToolEntry row={row} />;
  if (row.item["type"] === "reasoning") return <ReasoningEntry row={row} />;
  return <MessageEntry row={row} />;
}
function ReasoningEntry({ row }: { row: TimelineRow }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Disclosure id={id} title="Reasoning" open={open} onOpenChange={setOpen}>
      <MessageText>{string(row.item["text"], JSON.stringify(row.item, null, 2))}</MessageText>
    </Disclosure>
  );
}
function ToolEntry({ row }: { row: TimelineRow }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const status = string(row.item["status"], "unknown");
  return (
    <Disclosure
      id={id}
      title={string(row.item["name"], "Tool call")}
      open={open}
      onOpenChange={setOpen}
      status={<StatusPill tone={statusTone(status)}>{status}</StatusPill>}
    >
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <RelativeTime value={row.timestamp} />
          <CopyButton label="tool entry" value={JSON.stringify(row.item, null, 2)} />
        </div>
        <ToolDetails item={row.item} />
      </div>
    </Disclosure>
  );
}
function ToolDetails({ item }: { item: TimelineRow["item"] }) {
  const detail =
    typeof item["detail"] === "object" && item["detail"] !== null && !Array.isArray(item["detail"])
      ? item["detail"]
      : {};
  const input = item["input"] ?? item["arguments"] ?? detail["input"] ?? detail["command"];
  const output = item["output"] ?? item["result"] ?? detail["output"] ?? detail["text"];
  return (
    <>
      {input === undefined ? null : (
        <Section title={detail["type"] === "shell" ? "Command" : "Input"}>
          <CodeBlock label="Tool input">{content(input)}</CodeBlock>
        </Section>
      )}
      {output === undefined ? null : (
        <Section title="Output">
          <CodeBlock label="Tool output">{content(output)}</CodeBlock>
        </Section>
      )}
      {item["error"] == null ? null : (
        <Section title="Error">
          <CodeBlock label="Tool error">{content(item["error"])}</CodeBlock>
        </Section>
      )}
      {input === undefined && output === undefined && item["error"] == null ? (
        <CodeBlock label="Tool details">{JSON.stringify(item, null, 2)}</CodeBlock>
      ) : null}
    </>
  );
}
function MessageEntry({ row }: { row: TimelineRow }) {
  const type = string(row.item["type"], "event");
  const titles: Record<string, string> = { user_message: "User", assistant_message: "Assistant" };
  const text = typeof row.item["text"] === "string" ? row.item["text"] : null;
  const raw = JSON.stringify(row.item, null, 2);
  return (
    <article className="grid min-w-0 gap-2 border-b pb-4">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span>{titles[type] ?? type.replaceAll("_", " ")}</span>
          <span className="text-muted-foreground">
            <RelativeTime value={row.timestamp} />
          </span>
        </div>
        <CopyButton label="message" value={text ?? raw} />
      </div>
      {text === null ? (
        <CodeBlock label="Session event">{raw}</CodeBlock>
      ) : (
        <MessageText>{text}</MessageText>
      )}
    </article>
  );
}

/** Long prompts and replies preview in place; expanding keeps one reading scroll in the dialog. */
function MessageText({ children }: { children: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  useEffect(() => {
    const node = text.current;
    if (node === null) return undefined;
    const measure = () =>
      setOverflows(
        node.scrollHeight > Number.parseFloat(getComputedStyle(node).lineHeight) * 12 + 1,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className="grid min-w-0 justify-items-start gap-2">
      <p
        ref={text}
        id={id}
        className={cn(
          "w-full text-sm break-words whitespace-pre-wrap",
          expanded ? undefined : "line-clamp-12",
        )}
      >
        {children}
      </p>
      {overflows ? (
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={toggle}
        >
          {expanded ? "Show less" : "Show full message"}
        </Button>
      ) : null}
    </div>
  );
}
