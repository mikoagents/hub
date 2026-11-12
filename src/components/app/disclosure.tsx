import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";

/**
 * A bordered card whose header is the whole open/close target, or — inside a surface that
 * already has one — the same toggle without the box. Independent by construction —
 * each one owns its own `open`, so several can stand side by side without an accordion's
 * single-open rule closing the section someone is still typing into.
 *
 * The body is force-mounted: a half-filled form has to survive being collapsed, which a
 * conditionally rendered body cannot do. Radix hides it with `hidden`, so a collapsed section
 * is still invisible to sighted users, assistive technology, and test visibility checks.
 */
export function Disclosure({
  id,
  open,
  onOpenChange,
  media,
  title,
  description,
  status,
  variant = "section",
  children,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The brand mark. Decorative — the title carries the name. */
  media?: ReactNode;
  title: string;
  /** A sentence; an inline toggle's preview may also be a line of code. */
  description?: ReactNode;
  /** The single status indicator; file headers keep it beside the name. */
  status?: ReactNode;
  /**
   * File headers identify source. Inline toggles sit inside a record that already has a surface,
   * so they draw no box of their own: a chevron, the name, and a one-line preview of the body.
   */
  variant?: "section" | "file" | "inline";
  children: ReactNode;
}) {
  const headerId = `${id}-header`;
  const bodyId = `${id}-body`;
  // The compact header is a grid so the title, the description, and the status stack under one
  // another; a brand mark, when there is one, owns the column beside them. Without a mark there
  // is no column to leave empty — an empty column is still a `gap-x-3` indent, which put the
  // title 12px off the rail its own description sits on. From `sm` the header is a flex row and
  // an absent mark takes no space at all, so only the compact grid has a column to drop.
  const compact = media === undefined ? COMPACT_WITHOUT_MEDIA : COMPACT_WITH_MEDIA;
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className={variant === "inline" ? "min-w-0" : "min-w-0 rounded-xl border bg-card"}
      data-provider={id}
    >
      <CollapsibleTrigger
        id={headerId}
        aria-controls={bodyId}
        className={cn(
          "w-full items-center text-left",
          // Without a box there is no fill to promote on hover, so the quiet parts of the line
          // promote their colour instead.
          variant === "inline"
            ? "group/inline flex gap-2 rounded-sm"
            : "rounded-xl px-4 py-3 hover:bg-accent",
          variant === "file" ? "flex gap-3" : null,
          variant === "section"
            ? cn("grid gap-x-3 gap-y-1 sm:flex sm:gap-3", compact.columns)
            : null,
        )}
      >
        {variant === "inline" ? (
          <>
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-colors group-hover/inline:text-foreground",
                open && "rotate-90",
              )}
            />
            <span className="shrink-0 text-sm">{title}</span>
            {/* The preview stands in for a closed body; an open one says it in full below. */}
            {description === undefined || open ? null : (
              <span className="min-w-0 truncate text-sm text-muted-foreground transition-colors group-hover/inline:text-foreground">
                {description}
              </span>
            )}
          </>
        ) : null}
        {variant === "file" ? (
          <>
            <ChevronRight
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-muted-foreground", open && "rotate-90")}
            />
            <span className="min-w-0 truncate font-mono text-sm" title={title}>
              {title}
            </span>
            {status}
          </>
        ) : null}
        {variant === "section" ? (
          <>
            {media === undefined ? null : (
              <span aria-hidden="true" className="flex shrink-0 items-center">
                {media}
              </span>
            )}
            <span className="contents sm:grid sm:min-w-0 sm:flex-1 sm:gap-0.5">
              <span
                className={cn(
                  "row-start-1 truncate text-sm sm:col-auto sm:row-auto",
                  compact.title,
                )}
              >
                {title}
              </span>
              {description === undefined ? null : (
                <span
                  className={cn(
                    "row-start-2 text-sm text-muted-foreground sm:col-auto sm:row-auto",
                    compact.full,
                  )}
                >
                  {description}
                </span>
              )}
            </span>
            <span className="contents sm:flex sm:shrink-0 sm:items-center sm:gap-2">
              <span
                className={cn(
                  "row-start-3 justify-self-start sm:col-auto sm:row-auto",
                  compact.full,
                )}
              >
                {status}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "row-start-1 size-4 text-muted-foreground transition-transform sm:col-auto sm:row-auto",
                  compact.chevron,
                  open ? "rotate-180" : "",
                )}
              />
            </span>
          </>
        ) : null}
      </CollapsibleTrigger>
      {/* `forceMount` keeps the body in the DOM but stops Radix hiding it, so the closed state
          is ours to apply. `display: none` is what removes it from the page, the accessibility
          tree, and the tab order while leaving every typed value intact. */}
      <CollapsibleContent
        forceMount
        id={bodyId}
        role="region"
        aria-labelledby={headerId}
        className={cn(
          "min-w-0 overflow-hidden data-[state=closed]:hidden",
          variant === "inline" ? "pt-2" : "border-t px-4 py-4",
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Where the title, the stacked lines, and the chevron sit in the compact header's grid. */
const COMPACT_WITH_MEDIA = {
  columns: "grid-cols-[auto_minmax(0,1fr)_auto]",
  title: "col-start-2",
  full: "col-span-3",
  chevron: "col-start-3",
} as const;

const COMPACT_WITHOUT_MEDIA = {
  columns: "grid-cols-[minmax(0,1fr)_auto]",
  title: "col-start-1",
  full: "col-span-2",
  chevron: "col-start-2",
} as const;
