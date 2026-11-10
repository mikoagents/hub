/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop, eslint-plugin-react-perf/jsx-no-new-array-as-prop -- details compose shared summary and table slots */
import { useState, useCallback, useId } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useSnapshotQuery } from "../../queries/index.js";
import { CodeBlock } from "../../components/app/copy-field.js";
import { FailureAlert } from "../../components/app/failure-alert.js";
import { LoadingLine } from "../../components/app/loading.js";
import { EmptyState } from "../../components/app/empty-state.js";
import { Section } from "../../components/app/section.js";
import { Disclosure } from "../../components/app/disclosure.js";
import { SummaryPanel } from "../../components/app/summary-panel.js";
import { StatusPill, statusLabel } from "../../components/app/status-pill.js";
import { RelativeTime } from "../../components/app/relative-time.js";
import { Combobox } from "../../components/app/combobox.js";
import { codeTriggerRunDetail } from "../functions.js";
import { SessionHistory } from "../session-history.js";

export function CodeActivityDetail({
  view,
  ...scope
}: {
  organizationSlug: string;
  triggerId: string;
  runId: string;
  view: string;
}) {
  const load = useServerFn(codeTriggerRunDetail);
  const [selection, setSelection] = useState<string | null>(null);
  const [eventOpen, setEventOpen] = useState(false);
  const select = useCallback((option: { value: string }) => setSelection(option.value), []);
  const snapshot = useSnapshotQuery({
    queryKey: ["trigger-code-run", scope.organizationSlug, scope.runId],
    queryFn: () => load({ data: scope }),
    refetchInterval: 3000,
  });
  if (snapshot.status === "pending") return <LoadingLine>Loading Trigger run…</LoadingLine>;
  if (snapshot.status === "error")
    return (
      <FailureAlert
        title="Run unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load this Trigger run."
        onRetry={snapshot.refetch}
      />
    );
  const { run, operations, logs } = snapshot.data;
  const agents = operations.filter((operation) => operation.executionId !== null);
  const selected =
    agents.find((operation) => operation.id === selection) ??
    agents.find((operation) => operation.status === "waiting") ??
    agents[agents.length - 1];
  return (
    <div className="grid min-w-0 gap-5">
      <SummaryPanel
        label="Trigger run"
        rows={[
          {
            label: "Status",
            value: <StatusPill tone={runTone(run.status)}>{statusLabel(run.status)}</StatusPill>,
          },
          { label: "Started", value: <RelativeTime value={run.createdAt} /> },
          { label: "Deadline", value: <RelativeTime value={run.deadlineAt} /> },
        ]}
      />
      {run.error === null ? null : (
        <FailureAlert
          title={run.status === "skipped" ? "Run skipped" : "Run ended"}
          error={run.error}
          fallback="Inspect the run details."
        />
      )}
      {view === "conversation" && (
        <>
          {agents.length > 1 ? (
            <Combobox
              id={`code-agent-${run.id}`}
              label="Agent operation"
              placeholder="Select an agent operation"
              empty="No agent operations"
              value={selected?.id ?? ""}
              options={agents.map((operation) => ({
                value: operation.id,
                label: operation.id,
                detail: statusLabel(operation.status),
              }))}
              onChange={select}
            />
          ) : null}
          {selected?.executionId ? (
            <SessionHistory
              {...scope}
              executionId={selected.executionId}
              running={
                run.status === "running" || run.status === "waiting" || run.status === "queued"
              }
              view="conversation"
            />
          ) : (
            <EmptyState
              title="No agent session"
              description="This Trigger may process data or wait for an event. Run details show its code operations."
            />
          )}
        </>
      )}
      {view === "diagnostics" && (
        <Section title="Runner log">
          <CodeBlock label="Runner log">
            {logs.length === 0
              ? "No log entries."
              : logs
                  .map(
                    (log) =>
                      `${log.time} ${log.message}${log.data === null ? "" : ` ${JSON.stringify(log.data)}`}`,
                  )
                  .join("\n")}
          </CodeBlock>
        </Section>
      )}
      {view === "details" && (
        <>
          <Section title="Result">
            <CodeBlock label="Trigger result">{JSON.stringify(run.output, null, 2)}</CodeBlock>
          </Section>
          <Section title="Steps">
            {operations.length === 0 ? (
              <EmptyState title="No steps yet" />
            ) : (
              <div className="grid gap-3">
                {operations.map((operation) => (
                  <OperationDetail key={operation.id} operation={operation} />
                ))}
              </div>
            )}
          </Section>
          <Disclosure
            id={`code-event-${run.id}`}
            title="Trigger event"
            description={`${run.event.source}.${run.event.type}`}
            open={eventOpen}
            onOpenChange={setEventOpen}
          >
            <CodeBlock label="Trigger event">{JSON.stringify(run.event, null, 2)}</CodeBlock>
          </Disclosure>
        </>
      )}
    </div>
  );
}

function OperationDetail({
  operation,
}: {
  operation: {
    id: string;
    kind: string;
    status: string;
    input: unknown;
    output: unknown;
    error: string | null;
  };
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      id={`code-operation-${id}`}
      title={operation.id}
      description={operation.kind === "agent" ? "Agent call" : statusLabel(operation.kind)}
      open={open}
      onOpenChange={setOpen}
      status={
        <StatusPill tone={operation.status === "failed" ? "danger" : "neutral"}>
          {statusLabel(operation.status)}
        </StatusPill>
      }
    >
      <CodeBlock label={`${operation.id} result`}>
        {JSON.stringify(
          { input: operation.input, output: operation.output, error: operation.error },
          null,
          2,
        )}
      </CodeBlock>
    </Disclosure>
  );
}

function runTone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "danger";
  return "neutral";
}
