/* oxlint-disable eslint-plugin-jsx-a11y/no-noninteractive-tabindex -- the scrollable record body must be reachable by keyboard */
import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog.js";

export { DialogTrigger as DetailDialogTrigger };

/** A readable, viewport-contained surface for inspecting a record without leaving its list. */
export function DetailDialog({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  toolbar,
  scrollResetKey,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  trigger?: ReactNode;
  /** View controls stay beside the title while the record's body scrolls. */
  toolbar?: ReactNode;
  /** A different view starts at its beginning without discarding the record's state. */
  scrollResetKey?: string;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [scrollResetKey]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger}
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl",
          toolbar === undefined
            ? undefined
            : "h-[calc(100dvh-2rem)] sm:h-[min(48rem,calc(100dvh-4rem))]",
        )}
      >
        <div className="shrink-0 px-6 pt-6 pr-12 pb-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
        </div>
        {toolbar === undefined ? null : (
          <div className="shrink-0 border-b px-6 pb-4">{toolbar}</div>
        )}
        <div
          ref={body}
          data-slot="detail-dialog-body"
          role="region"
          aria-label={`${title} content`}
          tabIndex={0}
          className="min-h-0 min-w-0 flex-auto overflow-y-auto overscroll-contain p-6"
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
