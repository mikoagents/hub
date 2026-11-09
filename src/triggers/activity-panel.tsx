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
import { Button } from "../components/ui/button.js";
import { useRouteTenant } from "../projects/context.js";
import { triggerSnapshot, type TriggerSnapshot } from "./functions.js";
import { ActivityDetail } from "./activity-detail.js";

const ACTIVITY_COLUMNS = [
  { header: "Trigger", fill: true },
  { header: "Provider" },
  { header: "Source" },
  { header: "Status", fill: true },
  { header: "Received" },
];
const EMPTY_ACTIVITY = { title: "No activity" };
const ACTIVITY_DESCRIPTION = "Agent runs launched by organization triggers.";

export function TriggerActivityPanel() {
  const tenant = useRouteTenant();
  const load = useServerFn(triggerSnapshot);
  const organizationSlug = tenant.organization.slug;
  const snapshot = useSnapshotQuery({
    queryKey: ["triggers", organizationSlug],
    queryFn: () => load({ data: { organizationSlug } }),
  });
  if (snapshot.status === "pending") {
    return (
      <>
        <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
        <DataTableSkeleton label="Trigger activity" columns={ACTIVITY_COLUMNS} />
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
  const activity = snapshot.data.activity;
  return (
    <>
      <PageHeader title="Activity" description={ACTIVITY_DESCRIPTION} />
      <DataTable
        label="Trigger activity"
        columns={ACTIVITY_COLUMNS}
        isEmpty={activity.length === 0}
        empty={EMPTY_ACTIVITY}
      >
        {activity.map((run) => (
          <ActivityRow key={run.id} run={run} organizationSlug={organizationSlug} />
        ))}
      </DataTable>
    </>
  );
}

function ActivityRow({
  run,
  organizationSlug,
}: {
  run: TriggerSnapshot["activity"][number];
  organizationSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const select = useCallback(() => setOpen(true), []);
  return (
    <DetailDialog
      open={open}
      onOpenChange={setOpen}
      title="Activity details"
      description={run.triggerName}
      trigger={
        <DataRow onSelect={select}>
          <DataCell>
            <TwoLine
              primary={
                <DetailDialogTrigger asChild>
                  <Button variant="link">{run.triggerName}</Button>
                </DetailDialogTrigger>
              }
              {...(run.repo === null ? {} : { secondary: run.repo })}
            />
          </DataCell>
          <DataCell>{run.provider}</DataCell>
          <DataCell>{run.source}</DataCell>
          <DataCell>
            <TwoLine
              primary={<StatusPill tone={tone(run.status)}>{statusLabel(run.status)}</StatusPill>}
              {...(run.failureReason === null ? {} : { secondary: run.failureReason })}
            />
          </DataCell>
          <DataCell muted>
            <RelativeTime value={run.receivedAt} />
          </DataCell>
        </DataRow>
      }
    >
      {open ? (
        <ActivityDetail
          organizationSlug={organizationSlug}
          triggerId={run.triggerId}
          runId={run.id}
        />
      ) : null}
    </DetailDialog>
  );
}

function tone(status: string): "success" | "danger" | "neutral" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out" || status === "rejected") return "danger";
  return "neutral";
}
