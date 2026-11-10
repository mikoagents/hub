export const DAEMON_STATUS_FILTERS = ["all", "connected", "offline", "revoked"] as const;

export type DaemonStatusFilter = (typeof DAEMON_STATUS_FILTERS)[number];

export const DAEMON_STATUS_FILTER_OPTIONS: readonly {
  value: DaemonStatusFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "connected", label: "Connected" },
  { value: "offline", label: "Offline" },
  { value: "revoked", label: "Revoked" },
];

/** The status the daemons table shows, which is revoked before presence. */
export function daemonListStatus(daemon: {
  status: "active" | "revoked";
  presence: "offline" | "connected";
}): Exclude<DaemonStatusFilter, "all"> {
  if (daemon.status === "revoked") return "revoked";
  return daemon.presence === "connected" ? "connected" : "offline";
}

export function daemonMatchesStatus(
  daemon: { status: "active" | "revoked"; presence: "offline" | "connected" },
  filter: DaemonStatusFilter,
): boolean {
  return filter === "all" || daemonListStatus(daemon) === filter;
}

const DAEMON_FILTER_EMPTY_TITLES: Record<Exclude<DaemonStatusFilter, "all">, string> = {
  connected: "No connected daemons",
  offline: "No offline daemons",
  revoked: "No revoked daemons",
};

export function daemonFilterEmpty(filter: Exclude<DaemonStatusFilter, "all">): {
  title: string;
  description: string;
} {
  return {
    title: DAEMON_FILTER_EMPTY_TITLES[filter],
    description: "Choose All to view every daemon.",
  };
}
