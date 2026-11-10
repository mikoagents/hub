import type { TriggerManifest, TriggerSubscription } from "./sdk.js";
import { matchesPattern } from "./patterns.js";
import { describeRecurrence } from "../schedule/form.js";
import { eventDefinition, isEditorEvent } from "../configuration/events.js";
import type { TriggerInspection } from "./inspection-types.js";

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

export function subscriptionDescription(subscription: TriggerSubscription): string {
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

/** What a subscription's resource is, in the words of its source. */
export function subscriptionScopeLabel(source: string): string {
  return source === "github" ? "Repository" : "Resource";
}

/**
 * The collapsed "The event" row. One subscription stays a single sentence. Several stay one line
 * each, and a connection or repository is named once for the whole row only when every
 * subscription actually has that same value — a repository on one of them is not a repository
 * on all of them.
 */
export function eventConfigurationOverview(subscriptions: readonly TriggerSubscription[]): {
  summary: string;
  detail?: string;
} {
  const [only] = subscriptions;
  if (only === undefined) return { summary: "No events" };
  if (subscriptions.length === 1) {
    const detail = subscriptionDetail(only);
    return detail === undefined
      ? { summary: subscriptionSummary(only) }
      : { summary: subscriptionSummary(only), detail };
  }
  const sharedSource = sharedText(
    subscriptions.map((subscription) => triggerSourceLabel(subscription.source)),
  );
  const sharedConnection = sharedText(subscriptions.map((subscription) => subscription.connection));
  const sharedScopeLabel = sharedText(
    subscriptions.map((subscription) => subscriptionScopeLabel(subscription.source)),
  );
  const sharedScope =
    sharedScopeLabel === undefined
      ? undefined
      : sharedText(subscriptions.map((subscription) => subscription.resource));
  const summary = subscriptions
    .map((subscription) => {
      const name = eventLine(subscription, sharedSource);
      const own = [
        sharedConnection === undefined ? subscription.connection : undefined,
        sharedScope === undefined && subscription.resource !== undefined
          ? `${subscriptionScopeLabel(subscription.source)}: ${subscription.resource}`
          : undefined,
      ].filter((part): part is string => part !== undefined && part !== "");
      return [name, ...own].join(" · ");
    })
    .join("\n");
  const detail = [
    sharedConnection === undefined ? undefined : `Connection: ${sharedConnection}`,
    sharedScope !== undefined && sharedScopeLabel !== undefined
      ? `${sharedScopeLabel}: ${sharedScope}`
      : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return detail === "" ? { summary } : { summary, detail };
}

/** Drop a repeated source prefix so three GitHub lines do not each start with "GitHub ·". */
function eventLine(subscription: TriggerSubscription, sharedSource: string | undefined): string {
  const summary = subscriptionSummary(subscription);
  if (sharedSource === undefined) return summary;
  const prefix = `${sharedSource} · `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

function subscriptionDetail(subscription: TriggerSubscription): string | undefined {
  const parts = [
    subscription.connection !== undefined && subscription.connection !== ""
      ? `Connection: ${subscription.connection}`
      : undefined,
    subscription.resource !== undefined && subscription.resource !== ""
      ? `${subscriptionScopeLabel(subscription.source)}: ${subscription.resource}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** A value every entry shares, or nothing when any entry lacks it or disagrees. */
function sharedText(values: readonly (string | undefined)[]): string | undefined {
  const [first, ...rest] = values;
  if (first === undefined || first === "") return undefined;
  return rest.every((value) => value === first) ? first : undefined;
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
  const models = inspection.agents.map(({ provider, model }) => {
    if (provider.status !== "known" || model.status === "runtime") return "Computed at runtime";
    return model.status === "known"
      ? `${provider.value}/${model.value}`
      : (provider.value ?? "Defined in code");
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
