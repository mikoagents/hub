export const ACTIVITY_STATUS_FILTERS = ["all", "running", "succeeded", "failed"] as const;

export type ActivityStatusFilter = (typeof ACTIVITY_STATUS_FILTERS)[number];

export const ACTIVITY_STATUS_FILTER_OPTIONS: readonly {
  value: ActivityStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
];

/**
 * Terminal failures share one tab. The status pill still says failed, timed out, or rejected;
 * a segmented control only has room for a few short modes.
 */
const FAILED_STATUSES = new Set(["failed", "timed_out", "rejected"]);

export function activityMatchesStatus(status: string, filter: ActivityStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "running") return ["running", "queued", "waiting"].includes(status);
  if (filter === "failed") return FAILED_STATUSES.has(status);
  return status === filter;
}

const ACTIVITY_FILTER_EMPTY_TITLES: Record<Exclude<ActivityStatusFilter, "all">, string> = {
  running: "No running activity",
  succeeded: "No successful activity",
  failed: "No failed activity",
};

export function activityFilterEmpty(filter: ActivityStatusFilter): {
  title: string;
  description?: string;
} {
  if (filter === "all") return { title: "No activity" };
  return {
    title: ACTIVITY_FILTER_EMPTY_TITLES[filter],
    description: "Choose All to view every run.",
  };
}
