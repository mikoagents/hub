/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop -- source controls derive their options from the selected immutable revision */
import { useCallback, useId, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Combobox } from "../../components/app/combobox.js";
import { Card } from "../../components/app/card.js";
import { CodeBlock, CopyBlock } from "../../components/app/copy-field.js";
import { Disclosure } from "../../components/app/disclosure.js";
import { FailureAlert, NoticeAlert } from "../../components/app/failure-alert.js";
import { LoadingLine } from "../../components/app/loading.js";
import { StatusPill } from "../../components/app/status-pill.js";
import { useSnapshotQuery } from "../../queries/index.js";
import { codeTriggerDetail, type CodeTriggerDetail } from "../functions.js";
import { orderSourceFiles } from "./presentation.js";

const ENTRYPOINT_STATUS = (
  <StatusPill tone="neutral" dot={false}>
    Entrypoint
  </StatusPill>
);

export function TriggerSource({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: CodeTriggerDetail;
}) {
  return (
    <Card title="Source code">
      <SourceFiles organizationSlug={organizationSlug} current={current} />
    </Card>
  );
}

function SourceFiles({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: CodeTriggerDetail;
}) {
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const load = useServerFn(codeTriggerDetail);
  const selectRevision = useCallback(
    (option: { value: string }) => {
      setRevisionId(option.value === current.revisionId ? null : option.value);
    },
    [current.revisionId],
  );
  const snapshot = useSnapshotQuery({
    queryKey: ["trigger-code-revision", organizationSlug, current.id, revisionId],
    queryFn: () =>
      load({
        data: {
          organizationSlug,
          triggerId: current.id,
          ...(revisionId === null ? {} : { revisionId }),
        },
      }),
    enabled: revisionId !== null,
  });
  const data = revisionId === null ? current : snapshot.data;
  const files = orderSourceFiles(data?.artifact?.sources ?? [], data?.artifact?.entrypoint);
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Combobox
          id={`revision-${current.id}`}
          label="Code revision"
          placeholder="Choose a revision"
          empty="No revisions"
          value={revisionId ?? current.revisionId}
          onChange={selectRevision}
          options={current.revisions.map((revision) => ({
            value: revision.id,
            label: `Revision ${revision.version}`,
            detail: revision.id === current.revisionId ? "Current" : "Previous revision",
          }))}
        />
      </div>
      {revisionId !== null && snapshot.status === "pending" ? (
        <LoadingLine>Loading source…</LoadingLine>
      ) : null}
      {revisionId !== null && snapshot.status === "error" ? (
        <FailureAlert
          title="Source unavailable"
          error={snapshot.error}
          fallback="Hub couldn't load this revision."
          onRetry={snapshot.refetch}
        />
      ) : null}
      {data && !data.active ? (
        <NoticeAlert tone="neutral" title={`Viewing revision ${data.version}`}>
          This is an older revision. Run now uses the current revision, {current.version}.
        </NoticeAlert>
      ) : null}
      <div key={data?.revisionId} className="grid min-w-0 gap-3">
        {files.map((file) => (
          <SourceFile
            key={file.path}
            path={file.path}
            content={file.content}
            entrypoint={file.path === data?.artifact?.entrypoint}
          />
        ))}
      </div>
      {data?.artifact === null ? (
        <CodeBlock label="Historical Trigger configuration">{data.yaml ?? ""}</CodeBlock>
      ) : null}
    </div>
  );
}

function SourceFile({
  path,
  content,
  entrypoint,
}: {
  path: string;
  content: string;
  entrypoint: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      id={id}
      variant="file"
      title={path}
      status={entrypoint ? ENTRYPOINT_STATUS : undefined}
      open={open}
      onOpenChange={setOpen}
    >
      {open ? (
        <div className="grid min-w-0 gap-3">
          <CopyBlock label={path} action="Copy code" value={content} />
        </div>
      ) : null}
    </Disclosure>
  );
}
