import type { TriggerGrants, TriggerManifest, TriggerSubscription } from "./sdk.js";
import { matchesPattern } from "./patterns.js";
import { describeRecurrence } from "../schedule/form.js";
import { eventDefinition, isEditorEvent } from "../configuration/events.js";
import type { CodeField, TriggerInspection } from "./inspection-types.js";

const SOURCE_LABELS: Record<string, string> = {
  github: "GitHub",
  slack: "Slack",
  discord: "Discord",
  linear: "Linear",
  manual: "On demand",
  schedule: "Schedule",
};

export function triggerSourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source]! : source;
}

function eventLabel(event: string): string {
  if (event === "*") return "All events";
  const words = event.replace(/\.\*$/u, " events").replaceAll(/[_.]/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function subscriptionDescription(subscription: TriggerSubscription): string {
  if (subscription.source === "schedule" && subscription.recurrence)
    return describeRecurrence(subscription.recurrence);
  if (subscription.source === "manual" && matchesPattern("run", subscription.event))
    return "When you choose Run now";
  return (Array.isArray(subscription.event) ? subscription.event : [subscription.event])
    .map(eventLabel)
    .join(", ");
}

/** List and detail use the same wording rather than exposing serialized subscription objects. */
export function subscriptionSummary(subscription: TriggerSubscription): string {
  if (subscription.source === "schedule") return subscriptionDescription(subscription);
  if (subscription.source === "manual" && matchesPattern("run", subscription.event))
    return "On demand";
  return `${triggerSourceLabel(subscription.source)} · ${subscriptionDescription(subscription)}`;
}

export interface EventRecord {
  key: string;
  source: string;
  /** What happens: the events, the schedule, or "On demand". */
  primary: string;
  /** Where it happens: the source, then the scope and connection these events are limited to. */
  secondary: string;
}

/**
 * The configured events, one record per place they come from. Events that share a source,
 * repository, and connection are one record, so that scope is said once rather than under each
 * event; a repository on one subscription is still never shown as the scope of another.
 */
export function eventRecords(subscriptions: readonly TriggerSubscription[]): EventRecord[] {
  const groups = new Map<string, { source: string; events: Set<string>; secondary: string }>();
  for (const subscription of subscriptions) {
    const { key, events, secondary } = eventScope(subscription);
    const group = groups.get(key) ?? {
      source: subscription.source,
      events: new Set<string>(),
      secondary,
    };
    for (const event of events) group.events.add(event);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => ({
    key,
    source: group.source,
    primary: [...group.events].join(" · "),
    secondary: group.secondary,
  }));
}

function eventScope(subscription: TriggerSubscription): {
  key: string;
  events: string[];
  secondary: string;
} {
  const { source } = subscription;
  if (source === "schedule") {
    const description = subscriptionDescription(subscription);
    return {
      key: JSON.stringify([source, description]),
      events: [description],
      secondary: "Schedule",
    };
  }
  if (source === "manual" && matchesPattern("run", subscription.event))
    return {
      key: JSON.stringify([source]),
      events: ["On demand"],
      secondary: "When you choose Run now",
    };
  const secondary = [
    triggerSourceLabel(source),
    subscription.resource,
    subscription.connection ? `via ${subscription.connection}` : undefined,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
  return {
    key: JSON.stringify([source, subscription.resource ?? "", subscription.connection ?? ""]),
    events: (Array.isArray(subscription.event) ? subscription.event : [subscription.event]).map(
      eventLabel,
    ),
    secondary,
  };
}

export interface GithubAccess {
  connection: string;
  /** Each grant on the connection and the repositories it reaches. */
  grants: { alias: string; repositories: readonly string[] }[];
  /**
   * Each permission once, as GitHub's own settings name it: `pull_requests: write` is "Pull
   * requests". `shared` is the level when every grant has the same one; otherwise `levels` gives
   * each grant's own, "None" where a grant leaves the permission out.
   */
  permissions: {
    label: string;
    shared: string | null;
    levels: { alias: string; level: string }[];
  }[];
}

/**
 * What the code may do on GitHub, one record per connection. The grants on a connection are
 * listed together and their permissions said once, so two grants that differ only in which
 * repositories they reach do not repeat the same permissions. Stored manifests keep no key
 * order, so connections, grants, and permissions read in name order — `repository-2` before
 * `repository-10`, and permissions as GitHub's own settings list them.
 */
export function githubAccess(grants: NonNullable<TriggerGrants["github"]>): GithubAccess[] {
  const connections = new Map<string, [string, (typeof grants)[string]][]>();
  for (const [alias, grant] of Object.entries(grants).sort(([left], [right]) =>
    byName(left, right),
  ))
    connections.set(grant.connection, [
      ...(connections.get(grant.connection) ?? []),
      [alias, grant],
    ]);
  return [...connections]
    .sort(([left], [right]) => byName(left, right))
    .map(([connection, entries]) => ({
      connection,
      grants: entries.map(([alias, grant]) => ({ alias, repositories: grant.repositories })),
      permissions: [...new Set(entries.flatMap(([, grant]) => Object.keys(grant.permissions)))]
        .map((name) => {
          const levels = entries.map(([alias, grant]) => {
            const level = grant.permissions[name];
            return { alias, level: level === undefined ? "None" : sentence(level) };
          });
          const first = levels[0]?.level ?? "None";
          return {
            label: sentence(name),
            shared: levels.every((entry) => entry.level === first) ? first : null,
            levels,
          };
        })
        .sort((left, right) => byName(left.label, right.label)),
    }));
}

function byName(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

/** The values the code fixes for a setting: its one value, or each one a choice picks from. */
export function fixedValues(field: CodeField): string[] {
  if (field.status === "choice") return field.values;
  return field.status === "known" && field.value !== null ? [field.value] : [];
}

/** Values read as alternatives: "a", "a or b", "a, b, or c". */
export function oneOf(values: readonly string[]): string {
  return values.map((value, index) => value + choiceSeparator(index, values.length)).join("");
}

/** What follows the value at `index` when `count` values are read as alternatives. */
export function choiceSeparator(index: number, count: number): string {
  if (index >= count - 1) return "";
  if (count === 2) return " or ";
  return index === count - 2 ? ", or " : ", ";
}

/** Code shown inside a line of text: one line, cut short when it runs long. */
export function codeLine(code: string): string {
  const line = code.replaceAll(/\s+/gu, " ").trim();
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

function sentence(value: string): string {
  const words = value.replaceAll(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Keep event names separate from connection and recurrence details in the Trigger list. */
export function subscriptionListSummary(subscriptions: readonly TriggerSubscription[]): {
  primary: string;
  secondary?: string;
} {
  const labels = subscriptions.flatMap((subscription) => {
    if (subscription.source === "schedule") return ["Schedule"];
    const events = Array.isArray(subscription.event) ? subscription.event : [subscription.event];
    return events.map((event) => {
      const id = `${subscription.source}.${event}`;
      if (isEditorEvent(id)) return eventDefinition(id).label;
      const description = eventLabel(event);
      return `${triggerSourceLabel(subscription.source)} ${description.charAt(0).toLowerCase()}${description.slice(1)}`;
    });
  });
  const details = subscriptions.flatMap((subscription) => {
    if (subscription.source === "schedule" && subscription.recurrence)
      return [describeRecurrence(subscription.recurrence)];
    return subscription.connection ? [subscription.connection] : [];
  });
  return {
    primary: [...new Set(labels)].join(" · "),
    ...(details.length > 0 ? { secondary: [...new Set(details)].join(" · ") } : {}),
  };
}

/** Summarize parsed model literals without sending prompts or source expressions to the list. */
export function agentModelSummary(inspection: TriggerInspection): string {
  const models = inspection.agents.flatMap(({ provider, model }) => {
    const providers = fixedValues(provider);
    const names = fixedValues(model);
    // Two choices the code makes when it runs cannot be paired up from the code alone.
    if (
      providers.length === 0 ||
      model.status === "runtime" ||
      (providers.length > 1 && names.length > 1)
    )
      return ["Computed at runtime"];
    if (names.length === 0) return providers;
    return providers.flatMap((name) => names.map((value) => `${name}/${value}`));
  });
  if (inspection.limited) models.push("Defined in code");
  return [...new Set(models)].join(" · ") || "Code workflow";
}

export function triggerTargetSummary(manifest: TriggerManifest): {
  primary: string;
  secondary?: string;
  path: boolean;
} {
  const targets = Object.values(manifest.grants.targets ?? {});
  if (targets.length === 0) return { primary: `Runner: ${manifest.runner}`, path: false };
  const unique = [
    ...new Map(
      targets.map((target) => [JSON.stringify([target.daemon, target.cwd]), target]),
    ).values(),
  ];
  const first = unique[0]!;
  if (unique.length === 1) return { primary: first.daemon, secondary: first.cwd, path: true };
  return {
    primary: `${unique.length} targets`,
    secondary: unique.map(({ daemon, cwd }) => `${daemon}: ${cwd}`).join(" · "),
    path: false,
  };
}

export function hasManualEntry(manifest: TriggerManifest): boolean {
  return manifest.on.some(
    (entry) => entry.source === "manual" && matchesPattern("run", entry.event),
  );
}

/** Prefer the recorded entrypoint, then conventional workflow files, without changing stored order. */
export function orderSourceFiles<T extends { path: string }>(
  files: readonly T[],
  entrypoint?: string,
): T[] {
  const rank = (path: string) => {
    if (path === entrypoint) return -1;
    if (/(^|\/)trigger\.[cm]?[jt]s$/u.test(path)) return 0;
    if (/\.[cm]?[jt]sx?$/u.test(path)) return 1;
    return 2;
  };
  return [...files].sort(
    (left, right) => rank(left.path) - rank(right.path) || left.path.localeCompare(right.path),
  );
}
