/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- each record composes its shared dialog trigger and table row */
import { useSnapshotQuery } from "../queries/index.js";
import { useCallback, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { DataCell, DataRow, DataTable, DataTableSkeleton } from "../components/app/data-table.js";
import { FailureAlert } from "../components/app/failure-alert.js";
import { PageHeader } from "../components/app/page.js";
import { RelativeTime } from "../components/app/relative-time.js";
import { StatusPill, statusLabel } from "../components/app/status-pill.js";
import { TwoLine } from "../components/app/two-line.js";
import { DetailDialog, DetailDialogTrigger } from "../components/app/detail-dialog.js";
import { SegmentedControl } from "../components/app/segmented-control.js";
import { Button } from "../components/ui/button.js";
import { usePersistedChoice } from "../preferences/persisted-choice.js";
import { useRouteTenant } from "../projects/context.js";
import { triggerSnapshot, type TriggerSnapshot } from "./functions.js";
import { ACTIVITY_VIEWS, ActivityDetail } from "./activity-detail.js";
import { CodeActivityDetail } from "./code/activity-view.js";
import { triggerSourceLabel } from "./code/presentation.js";
import { triggerRunHistory } from "./functions.js";
import { LoadingLine } from "../components/app/loading.js";
import {
  ACTIVITY_STATUS_FILTERS,
  ACTIVITY_STATUS_FILTER_OPTIONS,
  activityFilterEmpty,
  activityMatchesStatus,
  type ActivityStatusFilter,
} from "./activity-filter.js";

const ACTIVITY_COLUMNS = [
  { header: "Trigger", fill: true },
  { header: "Provider" },
  { header: "Source" },
  { header: "Status", fill: true },
  { header: "Received" },
];
const ACTIVITY_DESCRIPTION = "Workflow runs, results and logs from your triggers.";
const HISTORY_COLUMNS = [
  { header: "Started", fill: true },
  { header: "Event", fill: true, className: "hidden sm:table-cell" },
  { header: "Status" },
];
const HISTORY_EMPTY = {
  title: "No runs yet",
  description:
    "Runs will appear here when a matching event arrives. If this Trigger has a manual entry, choose Run now to try it.",
};

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerSnapshot);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
  });
  const {
    value: filter,
    setValue: setFilter,
    ready,
  } = usePersistedChoice(
    `miko-hub-activity-status:${tenant.organization.id}`,
    ACTIVITY_STATUS_FILTERS,
    "all",
  );
  if (snapshot.status === "pending" || !ready) {
    return (
      <>
        <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
        <div className="grid gap-6">
          <ActivityStatusFilter value={filter} onChange={setFilter} />
          <DataTableSkeleton label="Trigger activity" columns={ACTIVITY_COLUMNS} />
        </div>
      </>
    );
  }
  if (snapshot.status === "error") {
    return (
      <FailureAlert
        title="Activity unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load trigger activity."
      />
    );
  }
  const activity = snapshot.data.activity.filter((run) =>
    activityMatchesStatus(run.status, filter),
  );
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      <div className="grid gap-6">
        <ActivityStatusFilter value={filter} onChange={setFilter} />
        <DataTable
          label="Trigger activity"
          columns={ACTIVITY_COLUMNS}
          isEmpty={activity.length === 0}
          empty={
            snapshot.data.activity.length === 0
              ? activityFilterEmpty("all")
              : activityFilterEmpty(filter)
          }
        >
          {activity.map((run) => (
            <ActivityRow key={run.id} run={run} organizationSlug={organizationSlug} />
          ))}
        </DataTable>
      </div>
    </>
  );
}

/** Per-Trigger history is fetched independently, so busy workflows cannot hide another's runs. */
export function TriggerRunHistory({
  organizationSlug,
  triggerId,
}: {
  organizationSlug: string;
  triggerId: string;
}) {
  const [count, setCount] = useState(5);
  const showMore = useCallback(() => setCount((value) => value + 5), []);
  const load = useServerFn(triggerRunHistory);
  const snapshot = useSnapshotQuery({
    queryKey: ["trigger-history", organizationSlug, triggerId],
    queryFn: () => load({ data: { organizationSlug, triggerId } }),
    refetchInterval: 3000,
  });
  if (snapshot.status === "pending") return <LoadingLine>Loading runs…</LoadingLine>;
  if (snapshot.status === "error")
    return (
      <FailureAlert
        title="Runs unavailable"
        error={snapshot.error}
        fallback="Hub couldn't load these runs."
        onRetry={snapshot.refetch}
      />
    );
  return (
    <div className="grid gap-3">
      <DataTable
        label="Run history"
        columns={HISTORY_COLUMNS}
        isEmpty={snapshot.data.length === 0}
        empty={HISTORY_EMPTY}
      >
        {snapshot.data.slice(0, count).map((run) => (
          <ActivityRow key={run.id} run={run} organizationSlug={organizationSlug} compact />
        ))}
      </DataTable>
      {snapshot.data.length > count ? (
        <div>
          <Button variant="outline" size="sm" onClick={showMore}>
            Show more runs
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ActivityStatusFilter({
  value,
  onChange,
}: {
  value: ActivityStatusFilter;
  onChange: (value: string) => void;
}) {
  return (
    <SegmentedControl
      label="Activity status"
      value={value}
      options={ACTIVITY_STATUS_FILTER_OPTIONS}
      onChange={onChange}
    />
  );
}

function ActivityRow({
  run,
  organizationSlug,
  compact = false,
}: {
  run: TriggerSnapshot["activity"][number];
  organizationSlug: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const initialView = compact ? "details" : "conversation";
  const [view, setView] = useState(initialView);
  const changeOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) setView(initialView);
    },
    [initialView],
  );
  const select = useCallback(() => changeOpen(true), [changeOpen]);
  return (
    <DetailDialog
      open={open}
      onOpenChange={changeOpen}
      title="Activity details"
      description={run.triggerName}
      scrollResetKey={view}
      toolbar={
        <SegmentedControl
          label="Activity view"
          value={view}
          options={ACTIVITY_VIEWS}
          onChange={setView}
        />
      }
      trigger={
        <DataRow onSelect={select}>
          <DataCell>
            <TwoLine
              primary={
                <DetailDialogTrigger asChild>
                  <Button
                    variant="link"
                    {...(compact ? { "aria-label": `Open run from ${run.receivedAt}` } : {})}
                  >
                    {compact ? <RelativeTime value={run.receivedAt} /> : run.triggerName}
                  </Button>
                </DetailDialogTrigger>
              }
              {...(run.repo === null ? {} : { secondary: run.repo })}
            />
          </DataCell>
          {compact ? null : <DataCell>{triggerSourceLabel(run.provider)}</DataCell>}
          <DataCell>{run.source}</DataCell>
          <DataCell>
            <TwoLine
              primary={<StatusPill tone={tone(run.status)}>{statusLabel(run.status)}</StatusPill>}
              {...(run.failureReason === null ? {} : { secondary: run.failureReason })}
            />
          </DataCell>
          {compact ? null : (
            <DataCell muted>
              <RelativeTime value={run.receivedAt} />
            </DataCell>
          )}
        </DataRow>
      }
    >
      {open &&
        (run.code ? (
          <CodeActivityDetail
            organizationSlug={organizationSlug}
            triggerId={run.triggerId}
            runId={run.id}
            view={view}
          />
        ) : (
          <ActivityDetail
            organizationSlug={organizationSlug}
            triggerId={run.triggerId}
            runId={run.id}
            view={view}
          />
        ))}
    </DetailDialog>
  );
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
