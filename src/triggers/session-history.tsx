/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- shared session facts and actions */
import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { triggerActivityTimeline } from "./functions.js";
import { useSnapshotQuery } from "../queries/index.js";
import { Section } from "../components/app/section.js";
import { SummaryPanel } from "../components/app/summary-panel.js";
import { CopyField } from "../components/app/copy-field.js";
import { Disclosure } from "../components/app/disclosure.js";
import { CodeBlock, CopyButton } from "../components/app/copy-field.js";
import { SessionTranscript } from "../components/app/session-transcript.js";
import { EmptyState } from "../components/app/empty-state.js";
import { FailureAlert, NoticeAlert } from "../components/app/failure-alert.js";
import { LoadingLine } from "../components/app/loading.js";
import { Button } from "../components/ui/button.js";
import type { TimelineRow, TimelineState } from "../session-timelines/store.js";

export function SessionHistory(scope: {
  organizationSlug: string;
  triggerId: string;
  runId: string;
  executionId: string;
  running: boolean;
  view: string;
}) {
  const load = useServerFn(triggerActivityTimeline);
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const snapshot = useSnapshotQuery({
    queryKey: [
      "activity-session",
      scope.organizationSlug,
      scope.triggerId,
      scope.runId,
      scope.executionId,
      before,
    ],
    queryFn: () =>
      load({
        data: {
          organizationSlug: scope.organizationSlug,
          triggerId: scope.triggerId,
          runId: scope.runId,
          executionId: scope.executionId,
          ...(before === undefined ? {} : { before }),
        },
      }),
    ...(scope.running ? { refetchInterval: 5000 } : {}),
  });
  const first = snapshot.data?.rows[0]?.seq;
  const earlier = useCallback(() => {
    if (first !== undefined) setCursors((current) => [...current, first]);
  }, [first]);
  const later = useCallback(() => setCursors((current) => current.slice(0, -1)), []);
  if (snapshot.status === "pending") return <LoadingLine>Loading session history…</LoadingLine>;
  if (snapshot.status === "error")
    return (
      <FailureAlert
        title="Session unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load this session."
        onRetry={snapshot.refetch}
      />
    );
  const { state, rows, availability, hasOlder, unavailableReason } = snapshot.data;
  const diagnostics = scope.view === "diagnostics";
  return (
    <Section
      title={diagnostics ? "Session details" : "Conversation"}
      description={sessionDescription(diagnostics, state)}
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={snapshot.isFetching}
          onClick={snapshot.refetch}
        >
          Refresh session
        </Button>
      }
    >
      {state === null ? (
        <EmptyState
          title="Session history unavailable"
          description={unavailableReason ?? "Recorded runtime events are available in Diagnostics."}
        />
      ) : (
        <>
          {availability === "connected" ? null : (
            <NoticeAlert tone="neutral" title="Saved session history">
              {unavailableReason} Showing the last synchronized messages.
            </NoticeAlert>
          )}
          {state.hasNewer ? (
            <NoticeAlert tone="neutral" title="More messages to synchronize">
              Refresh to continue retrieving messages from this session.
            </NoticeAlert>
          ) : null}
          {diagnostics ? (
            <SessionDiagnostics executionId={scope.executionId} state={state} rows={rows} />
          ) : (
            <SessionMessages rows={rows} />
          )}
          {hasOlder || cursors.length > 0 ? (
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasOlder || first === undefined || snapshot.isFetching}
                onClick={earlier}
              >
                Earlier messages
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length === 0 || snapshot.isFetching}
                onClick={later}
              >
                Later messages
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Section>
  );
}

function sessionDescription(diagnostics: boolean, state: TimelineState | null): string {
  if (diagnostics) return "Provider and runtime information for this session.";
  if (state === null) return "Messages from this agent session.";
  return [state.agent.provider, state.agent.model].filter(Boolean).join(" · ");
}

function SessionMessages({ rows }: { rows: TimelineRow[] }) {
  if (rows.length === 0) return <EmptyState title="No session messages" />;
  return <SessionTranscript rows={rows} />;
}

function SessionDiagnostics({
  executionId,
  state,
  rows,
}: {
  executionId: string;
  state: TimelineState;
  rows: TimelineRow[];
}) {
  const [open, setOpen] = useState(false);
  const raw = JSON.stringify(rows, null, 2);
  return (
    <>
      <SummaryPanel
        label="Session details"
        rows={[
          { label: "Provider", value: state.agent.provider },
          { label: "Model", value: state.agent.model ?? "—" },
          { label: "Status", value: state.agent.status },
          {
            label: "Working directory",
            value: <span className="font-mono text-xs break-all">{state.agent.cwd}</span>,
          },
          {
            label: "Provider session",
            value: (
              <span className="font-mono text-xs break-all">
                {state.agent.providerSessionId ?? "—"}
              </span>
            ),
          },
        ]}
      />
      <CopyField
        label="Inspect with Miko CLI"
        value={`miko agent inspect ${state.agent.nativeAgentId}`}
      />
      <CopyField label="View session logs" value={`miko agent logs ${state.agent.nativeAgentId}`} />
      <Disclosure
        id={`session-details-${executionId}`}
        title="Raw session data"
        open={open}
        onOpenChange={setOpen}
      >
        <Section title="Session diagnostics">
          <CodeBlock label="Session diagnostics">{JSON.stringify(state.agent, null, 2)}</CodeBlock>
        </Section>
        <Section title="Message data" action={<CopyButton label="session data" value={raw} />}>
          <CodeBlock label="Session message data">{raw}</CodeBlock>
        </Section>
      </Disclosure>
    </>
  );
}
