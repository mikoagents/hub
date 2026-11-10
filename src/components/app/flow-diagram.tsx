/* oxlint-disable eslint-plugin-react-perf/jsx-no-jsx-as-prop -- the diagram composes a shared inspection dialog */
/* oxlint-disable eslint-plugin-jsx-a11y/no-noninteractive-tabindex -- the scrollable SVG must be reachable by keyboard */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "../ui/button.js";
import { DetailDialog, DetailDialogTrigger } from "./detail-dialog.js";
import { NoticeAlert } from "./failure-alert.js";
import { LoadingLine } from "./loading.js";

async function render(source: string, host: HTMLElement, idPrefix: string): Promise<string> {
  const { renderAsync } = await import("pele/lazy");
  await document.fonts.ready;
  const style = getComputedStyle(host);
  const { svg } = await renderAsync(source, {
    idPrefix,
    fontFamily: style.fontFamily,
    fontSize: Number.parseFloat(style.fontSize),
    responsive: false,
    limit: 12000,
    maxEdges: 200,
    links: false,
    images: false,
  });
  return svg;
}

/** A diagram can be inspected at full size without letting wide graphs stretch the page. */
export function FlowDiagram({ source, label }: { source: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid min-w-0 gap-2">
      <DiagramImage source={source} label={label} />
      <div className="flex justify-end">
        <DetailDialog
          title="Workflow diagram"
          description={label}
          open={open}
          onOpenChange={setOpen}
          trigger={
            <DetailDialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Maximize2 aria-hidden="true" />
                Expand diagram
              </Button>
            </DetailDialogTrigger>
          }
        >
          {open ? <DiagramImage source={source} label={label} expanded /> : null}
        </DetailDialog>
      </div>
    </div>
  );
}

function DiagramImage({
  source,
  label,
  expanded = false,
}: {
  source: string;
  label: string;
  expanded?: boolean;
}) {
  const id = useId();
  const idPrefix = `hub-flow-${id.replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;
  const host = useRef<HTMLDivElement>(null);
  const key = source;
  const [result, setResult] = useState<{ key: string; svg?: string; failed?: boolean } | null>(
    null,
  );
  const svg = result?.key === key ? result.svg : undefined;
  const markup = useMemo(() => ({ __html: svg ?? "" }), [svg]);
  const failed = result?.key === key && result.failed;
  useEffect(() => {
    if (!host.current) return undefined;
    let cancelled = false;
    void render(source, host.current, idPrefix)
      .then((value) => {
        if (!cancelled) setResult({ key, svg: value });
        return value;
      })
      .catch(() => {
        if (!cancelled) setResult({ key, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [key, source, idPrefix]);
  if (failed)
    return (
      <NoticeAlert tone="neutral" title="Diagram unavailable">
        Open the Trigger details or source code to inspect this workflow.
      </NoticeAlert>
    );
  return (
    <div ref={host} className="flow-diagram min-w-0">
      {svg === undefined ? (
        <LoadingLine>Drawing workflow…</LoadingLine>
      ) : (
        <div
          role="img"
          aria-label={label}
          tabIndex={0}
          className={
            expanded
              ? "max-h-[70dvh] overflow-auto rounded-lg bg-card p-3 [&_svg]:mx-auto [&_svg]:max-w-none"
              : "max-h-96 overflow-auto rounded-lg bg-card p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-none sm:[&_svg]:max-w-full"
          }
          // oxlint-disable-next-line react/no-danger -- Pele escapes text and filters SVG styles; links and external images are disabled.
          dangerouslySetInnerHTML={markup}
        />
      )}
    </div>
  );
}
