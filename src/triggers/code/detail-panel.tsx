/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- workflow cards compose their source and status controls */
import { useCallback } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "../../components/app/card.js";
import { FailureAlert, NoticeAlert } from "../../components/app/failure-alert.js";
import { LoadingLine } from "../../components/app/loading.js";
import { PageHeader } from "../../components/app/page.js";
import { Section } from "../../components/app/section.js";
import { Button } from "../../components/ui/button.js";
import { useSnapshotQuery } from "../../queries/index.js";
import { useRouteTenant } from "../../projects/context.js";
import { codeTriggerDetail, codeTriggerAction } from "../functions.js";
import { TriggerRunHistory } from "../activity-panel.js";
import { hasManualEntry } from "./presentation.js";
import { TriggerSource } from "./source-view.js";
import { TriggerSettings } from "./settings-view.js";
import { TriggerFlow } from "./flow-view.js";

type Action = "run" | "enable" | "disable";
const ACTION_FEEDBACK = {
  run: { title: "Run queued", message: "Follow its progress in Run history below." },
  enable: { title: "Trigger enabled", message: "Matching events can start new runs." },
  disable: {
    title: "Trigger disabled",
    message: "New runs are paused. Existing runs can still finish.",
  },
};
const ENABLED_STATUS = { label: "Enabled", tone: "success" } as const;
const DISABLED_STATUS = { label: "Disabled", tone: "neutral" } as const;

export function TriggerDetailPanel({ triggerId }: { triggerId: string }) {
  const { organization } = useRouteTenant();
  const organizationSlug = organization.slug;
  const load = useServerFn(codeTriggerDetail);
  const act = useServerFn(codeTriggerAction);
  const client = useQueryClient();
  const source = useSnapshotQuery({
    queryKey: ["trigger-code", organizationSlug, triggerId],
    queryFn: () => load({ data: { organizationSlug, triggerId } }),
  });
  const mutation = useMutation({
    mutationFn: async (action: Action) => {
      const result = await act({ data: { organizationSlug, triggerId, action } });
      if (result.status === "error") throw new Error(result.error.message);
      return result;
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["triggers", organizationSlug] }),
        client.invalidateQueries({ queryKey: ["trigger-code", organizationSlug, triggerId] }),
        client.invalidateQueries({ queryKey: ["trigger-history", organizationSlug, triggerId] }),
      ]);
    },
  });
  if (source.status === "pending")
    return (
      <>
        <PageHeader title="Trigger" />
        <LoadingLine>Loading Trigger…</LoadingLine>
      </>
    );
  if (source.status === "error")
    return (
      <>
        <PageHeader title="Trigger" />
        <FailureAlert
          title="Trigger unavailable"
          error={source.error}
          fallback="Hub couldn't load this Trigger."
          onRetry={source.refetch}
        />
      </>
    );
  const data = source.data;
  const manifest = data.artifact?.manifest;
  const feedback =
    mutation.isSuccess && mutation.variables ? ACTION_FEEDBACK[mutation.variables] : null;
  return (
    <>
      <PageHeader title={data.name} status={data.enabled ? ENABLED_STATUS : DISABLED_STATUS}>
        {data.canManage && manifest ? (
          <TriggerActions
            enabled={data.enabled}
            busy={mutation.isPending}
            manual={hasManualEntry(manifest)}
            onAction={mutation.mutate}
          />
        ) : null}
      </PageHeader>
      {mutation.error ? (
        <FailureAlert
          standalone
          title="Trigger action failed"
          error={mutation.error}
          fallback="Try again."
        />
      ) : null}
      {feedback ? (
        <NoticeAlert standalone tone="success" title={feedback.title}>
          {feedback.message}
        </NoticeAlert>
      ) : null}
      <Section>
        {manifest ? (
          <Card
            title="How it runs"
            description={
              manifest.description ??
              "Matching events start your workflow. Results and logs are saved with each run."
            }
          >
            <TriggerFlow manifest={manifest} />
          </Card>
        ) : (
          <NoticeAlert standalone tone="neutral" title="Previous configuration">
            Deploy a code project with the same name to update this Trigger and keep its history.
          </NoticeAlert>
        )}
      </Section>
      {manifest ? <TriggerSettings manifest={manifest} inspection={data.inspection} /> : null}
      <Section title="Run history" description="Open a run to see its result, steps and logs.">
        <TriggerRunHistory organizationSlug={organizationSlug} triggerId={triggerId} />
      </Section>
      <Section>
        <TriggerSource organizationSlug={organizationSlug} current={data} />
      </Section>
    </>
  );
}

function TriggerActions({
  enabled,
  busy,
  manual,
  onAction,
}: {
  enabled: boolean;
  busy: boolean;
  manual: boolean;
  onAction: (action: Action) => void;
}) {
  const toggle = useCallback(() => onAction(enabled ? "disable" : "enable"), [enabled, onAction]);
  const run = useCallback(() => onAction("run"), [onAction]);
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={toggle}>
        {enabled ? "Disable" : "Enable"}
      </Button>
      {manual ? (
        <Button disabled={!enabled || busy} onClick={run}>
          Run now
        </Button>
      ) : null}
    </>
  );
}
