import type { TriggerManifest } from "./sdk.js";
import { subscriptionSummary } from "./presentation.js";

function label(value: string): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  const short = singleLine.length > 60 ? `${singleLine.slice(0, 59)}…` : singleLine;
  const escaped = short.replaceAll(/["<>\\#&]/gu, (character) => `#${character.charCodeAt(0)};`);
  return `"${escaped}"`;
}

/** Describe only declared events and code execution; arbitrary JavaScript cannot be statically inferred. */
export function triggerFlowDiagram(
  manifest: TriggerManifest,
  direction: "LR" | "TB" = "LR",
): string {
  if (manifest.diagram) return manifest.diagram;
  const lines = [`flowchart ${direction}`];
  manifest.on.forEach((entry, index) => {
    lines.push(`  event${index}([${label(subscriptionSummary(entry))}]) --> workflow`);
  });
  lines.push('  workflow["Run workflow code"] --> result["Result and logs"]');
  return lines.join("\n");
}
