/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- shared record surfaces accept composed facts and actions */
import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CodeBlock, CopyButton } from "../components/app/copy-field.js";
import { Card } from "../components/app/card.js";
import { Disclosure } from "../components/app/disclosure.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { LoadingLine } from "../components/app/loading.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { Section } from "../components/app/section.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { SummaryPanel } from "../components/app/summary-panel.js";
import { Button } from "../components/ui/button.js";
import { useSnapshotQuery } from "../queries/index.js";
import { triggerActivitySnapshot, triggerActivityLogs } from "./functions.js";

interface ActivityScope {
  organizationSlug: string;
  triggerId: string;
  runId: string;
}

export function ActivityDetail(scope: ActivityScope) {
  const load = useServerFn(triggerActivitySnapshot);
  const [contextOpen, setContextOpen] = useState(false);
  const snapshot = useSnapshotQuery({
    queryKey: ["trigger-activity", scope.organizationSlug, scope.triggerId, scope.runId],
    queryFn: () => load({ data: scope }),
    refetchInterval: 5000,
  });
  if (snapshot.status === "pending") return <LoadingLine>Loading run details…</LoadingLine>;
  if (snapshot.status === "error")
    return (
      <FailureAlert
        title="Run unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load this run."
        onRetry={snapshot.refetch}
      />
    );
  const activity = snapshot.data.activity;
  return (
    <>
      <Section title="Overview">
        <SummaryPanel
          label="Run overview"
          rows={[
            { label: "Status", value: <RunStatus status={activity.status} /> },
            { label: "Source", value: `${activity.provider} · ${activity.source}` },
            { label: "Received", value: <RelativeTime value={activity.receivedAt} /> },
            { label: "Started", value: <RelativeTime value={activity.createdAt} /> },
            {
              label: "Completed",
              value:
                activity.completedAt === null ? "—" : <RelativeTime value={activity.completedAt} />,
            },
            { label: "Failure reason", value: activity.failureReason ?? "—" },
          ]}
        />
      </Section>
      <Section title="Prompt" action={<CopyButton label="prompt" value={activity.prompt} />}>
        <CodeBlock label="Run prompt">{activity.prompt}</CodeBlock>
      </Section>
      <Section title="Steps">
        {activity.steps.length === 0 ? (
          <EmptyState title="No steps" />
        ) : (
          <div className="grid gap-4">
            {activity.steps.map((step) => (
              <Card
                key={step.id}
                title={`${String(step.ordinal + 1)}. ${step.stepId}`}
                action={<RunStatus status={step.status} />}
              >
                <SummaryPanel
                  label={`${step.stepId} details`}
                  rows={[
                    {
                      label: "Started",
                      value:
                        step.startedAt === null ? "—" : <RelativeTime value={step.startedAt} />,
                    },
                    {
                      label: "Completed",
                      value:
                        step.completedAt === null ? "—" : <RelativeTime value={step.completedAt} />,
                    },
                    {
                      label: "Agent",
                      value:
                        step.agentId === null ? (
                          "—"
                        ) : (
                          <span className="font-mono text-xs break-all">{step.agentId}</span>
                        ),
                    },
                    { label: "Failure reason", value: step.failureReason ?? "—" },
                  ]}
                />
                {step.output === null ? null : (
                  <Section title="Structured output">
                    <CodeBlock label={`${step.stepId} output`}>{json(step.output)}</CodeBlock>
                  </Section>
                )}
                {step.executionId === null ? (
                  <EmptyState
                    title="No execution log"
                    description="This step has not started an agent."
                  />
                ) : (
                  <ExecutionLog
                    {...scope}
                    executionId={step.executionId}
                    running={activity.status === "running"}
                  />
                )}
              </Card>
            ))}
          </div>
        )}
      </Section>
      <Disclosure
        id={`run-context-${activity.id}`}
        title="Event and context"
        open={contextOpen}
        onOpenChange={setContextOpen}
      >
        <SummaryPanel
          label="Run evidence"
          rows={[
            {
              label: "Run ID",
              value: <span className="font-mono text-xs break-all">{activity.id}</span>,
            },
            {
              label: "Delivery ID",
              value: <span className="font-mono text-xs break-all">{activity.deliveryId}</span>,
            },
          ]}
        />
        <Section title="Inputs">
          <CodeBlock label="Run inputs">{json(activity.inputs)}</CodeBlock>
        </Section>
        <Section title="Routing values">
          <CodeBlock label="Routing values">{json(activity.values)}</CodeBlock>
        </Section>
        <Section title="Trigger context">
          <CodeBlock label="Trigger context">{json(activity.triggerContext)}</CodeBlock>
        </Section>
        <Section title="Output context">
          <CodeBlock label="Output context">{json(activity.outputContext)}</CodeBlock>
        </Section>
        <Section title="Event payload">
          <CodeBlock label="Event payload">{json(activity.rawPayload)}</CodeBlock>
        </Section>
      </Disclosure>
    </>
  );
}

function ExecutionLog({
  executionId,
  running,
  ...scope
}: ActivityScope & { executionId: string; running: boolean }) {
  const load = useServerFn(triggerActivityLogs);
  const [cursors, setCursors] = useState(["0"]);
  const cursor = cursors[cursors.length - 1];
  const snapshot = useSnapshotQuery({
    queryKey: [
      "trigger-activity-logs",
      scope.organizationSlug,
      scope.triggerId,
      scope.runId,
      executionId,
      cursor,
    ],
    queryFn: () => load({ data: { ...scope, executionId, after: cursor } }),
    ...(running ? { refetchInterval: 5000 } : {}),
  });
  const nextCursor = snapshot.data?.nextCursor;
  const next = useCallback(() => {
    if (nextCursor != null) setCursors((current) => [...current, nextCursor]);
  }, [nextCursor]);
  const previous = useCallback(() => setCursors((current) => current.slice(0, -1)), []);
  if (snapshot.status === "pending") return <LoadingLine>Loading execution log…</LoadingLine>;
  if (snapshot.status === "error")
    return (
      <FailureAlert
        title="Log unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load this execution log."
        onRetry={snapshot.refetch}
      />
    );
  const entries = snapshot.data.entries;
  const log = entries.map((entry) => `${entry.recordedAt}\n${json(entry.event)}`).join("\n\n");
  return (
    <Section
      title="Execution log"
      description={
        running
          ? "Updates every 5 seconds while this run is active."
          : "Recorded agent messages, tool calls, and lifecycle events."
      }
      action={entries.length === 0 ? undefined : <CopyButton label="log page" value={log} />}
    >
      {entries.length === 0 ? (
        <EmptyState
          title="No recorded log"
          description={
            running
              ? "Waiting for agent events."
              : "No agent events were recorded for this execution. Historical logs are unavailable if the run predates log capture."
          }
        />
      ) : (
        <CodeBlock label={`Execution log ${executionId}`}>{log}</CodeBlock>
      )}
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" disabled={cursors.length === 1} onClick={previous}>
          Earlier entries
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">Page {cursors.length}</span>
        <Button variant="outline" size="sm" disabled={nextCursor == null} onClick={next}>
          Later entries
        </Button>
      </div>
    </Section>
  );
}

function RunStatus({ status }: { status: string }) {
  const tone = runTone(status);
  return <StatusPill tone={tone}>{statusLabel(status)}</StatusPill>;
}

function runTone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (["failed", "timed_out", "rejected"].includes(status)) return "danger";
  return "neutral";
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "—";
}
