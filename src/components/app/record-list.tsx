import type { ReactNode } from "react";

/**
 * A short list of records inside a card, for the times a table would be wrong: the records are
 * already grouped by the card's own subject, so a header row would only repeat it.
 *
 * A table is still the answer for a page-level list of many records with real columns. Reach for
 * this when a card owns a handful of rows and the only columns are "what it is" and "what state
 * it is in" — four provider cards each listing their own connections, not one connections table.
 */
export function RecordList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="grid divide-y divide-border">
      {children}
    </ul>
  );
}

/**
 * One record: what it is on the left, its state and its actions on the right. The row owns the
 * distance to its neighbours so no card decides that for itself.
 *
 * A record that is more than its name — an agent call with its settings, a grant with its
 * permissions — puts those facts in `details`, under the name and in line with it, so the name
 * stays the one line a reader scans the list by.
 */
export function RecordRow({
  media,
  children,
  status,
  actions,
  details,
}: {
  /** A glyph saying what kind of record this is: a provider mark, a daemon. Decorative. */
  media?: ReactNode;
  /** The identity of the record, normally a `TwoLine`. */
  children: ReactNode;
  /** Its state, always a `StatusPill`. */
  status?: ReactNode;
  /** Its actions, always behind a `RowActions` kebab. */
  actions?: ReactNode;
  /** What else the record holds, normally a `SummaryPanel` of facts. */
  details?: ReactNode;
}) {
  return (
    <li className="grid min-w-0 gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {media === undefined ? null : (
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-foreground [&>svg]:size-4"
            >
              {media}
            </span>
          )}
          <div className="min-w-0">{children}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status}
          {actions}
        </div>
      </div>
      {details === undefined ? null : (
        // The details start where the name does, so a glyph is a margin, not a column of its own.
        <div className={media === undefined ? "min-w-0" : "min-w-0 pl-11"}>{details}</div>
      )}
    </li>
  );
}
