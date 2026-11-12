import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";

export interface SummaryRow {
  label: string;
  value: ReactNode;
}

/**
 * The four shapes a description list takes. `grid` is a bordered panel of its own. `groups`
 * names the parts of a surface that already has a border — a label column beside each part, a
 * hairline between them — so the parts read as siblings and their contents as children. `facts`
 * is a compact run of label-over-value pairs inside a record, with no rules of its own. `names`
 * sets names from code beside what each stands for: a grant beside the repositories it reaches.
 */
const LAYOUTS = {
  grid: {
    // A one-pixel gap over the border colour is the divider. No extra element, and the rows
    // reflow into one column on a phone without the rules ending up in the wrong places.
    //
    // The tracks are fitted rather than fixed at two: a panel of one fact filled half a box
    // and left the other half empty, and a panel of three left a hole under the third.
    list: "grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))]",
    row: "grid content-start gap-1 bg-card px-4 py-3",
    term: "text-xs text-muted-foreground",
  },
  groups: {
    list: "grid min-w-0 divide-y divide-border",
    // The label is a step larger than the facts inside the group: it names a part of the
    // surface, not a value, and the column it sits in is what sets it apart from them.
    row: "grid min-w-0 gap-3 py-5 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6",
    term: "text-sm text-muted-foreground",
  },
  facts: {
    // Filled tracks rather than a wrapping row: every record in a list lines its facts up in the
    // same columns, so "Mode" sits over "Mode" all the way down.
    list: "grid min-w-0 grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-x-4 gap-y-3",
    row: "grid min-w-0 content-start gap-1",
    term: "text-xs text-muted-foreground",
  },
  names: {
    // The names share one column, so every value starts on the same rail however long the name
    // beside it is. The rows dissolve into the grid; the terms and definitions are its cells.
    list: "grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1",
    row: "contents",
    term: "font-mono text-xs text-muted-foreground",
  },
} as const;

/**
 * What a finished piece of setup amounts to, as labelled rows rather than a stack of sentences.
 * Four anonymous lines of body text say the same words and give the eye nothing to land on; a
 * description list gives every fact a name, a place, and a shape a screen reader can navigate.
 */
export function SummaryPanel({
  label,
  rows,
  layout = "grid",
  className,
}: {
  /** Identifies which summary this is, e.g. "GitHub app". */
  label: string;
  rows: readonly SummaryRow[];
  layout?: keyof typeof LAYOUTS;
  /** Placement in a parent grid only. Never used to change how the panel looks. */
  className?: string;
}) {
  const shape = LAYOUTS[layout];
  return (
    <dl
      // No role override. A description list already exposes its rows as terms and definitions,
      // and naming the container costs exactly that. The attribute is a test hook, nothing more.
      data-summary={label}
      className={cn(shape.list, className)}
    >
      {rows.map((row) => (
        <div key={row.label} className={shape.row}>
          <dt className={shape.term}>{row.label}</dt>
          <dd className="min-w-0 text-sm break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
