/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- configuration cards project code values into shared summary components */
import { useState, type ReactNode } from "react";
import { Card } from "../../components/app/card.js";
import { CodeBlock } from "../../components/app/copy-field.js";
import { Disclosure } from "../../components/app/disclosure.js";
import { Section } from "../../components/app/section.js";
import { SummaryPanel } from "../../components/app/summary-panel.js";
import type { TriggerManifest, TriggerSubscription } from "./sdk.js";
import type { CodeField, InspectedAgent, TriggerInspection } from "./inspection-types.js";
import {
  eventConfigurationOverview,
  subscriptionDescription,
  subscriptionScopeLabel,
  subscriptionSummary,
} from "./presentation.js";

export function TriggerSettings({
  manifest,
  inspection,
}: {
  manifest: TriggerManifest;
  inspection: TriggerInspection | null;
}) {
  const targets = Object.entries(manifest.grants.targets ?? {});
  const github = Object.entries(manifest.grants.github ?? {});
  const subscriptions = [
    ...new Map(
      manifest.on.map((subscription) => [JSON.stringify(subscription), subscription]),
    ).values(),
  ];
  const agents = inspection?.agents ?? [];
  const events = eventConfigurationOverview(subscriptions);
  const repositories = github.flatMap(([, grant]) => grant.repositories);
  return (
    <Section>
      <Card title="Configuration">
        <div className="grid min-w-0 divide-y divide-border">
          <ConfigurationRow
            id="configuration-event"
            title="The event"
            summary={events.summary}
            {...(events.detail === undefined ? {} : { detail: events.detail })}
          >
            <div className="grid min-w-0 gap-4">
              {subscriptions.map((subscription) => (
                <EventConfiguration
                  key={JSON.stringify(subscription)}
                  subscription={subscription}
                />
              ))}
            </div>
          </ConfigurationRow>
          <ConfigurationRow
            id="configuration-target"
            title="Where it runs"
            summary={
              targets.length > 0
                ? summarize(targets.map(([, target]) => target.daemon))
                : "Runner " + manifest.runner
            }
            detail={[
              targets.length > 0
                ? "Directory: " + summarize(targets.map(([, target]) => target.cwd))
                : null,
              "Workflow limit: " + manifest.limits.maxRuntime,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <div className="grid min-w-0 gap-4">
              {targets.map(([alias, target]) => (
                <SummaryPanel
                  key={alias}
                  layout="rows"
                  label={alias + " execution target"}
                  rows={[
                    { label: "Target", value: alias },
                    { label: "Daemon", value: target.daemon },
                    { label: "Working directory", value: target.cwd },
                    { label: "Allowed providers", value: target.providers.join(", ") },
                  ]}
                />
              ))}
              <SummaryPanel
                layout="rows"
                label="Workflow runner"
                rows={[
                  { label: "Workflow runner", value: manifest.runner },
                  { label: "Workflow time limit", value: manifest.limits.maxRuntime },
                  {
                    label: "Agent call limit",
                    value: manifest.limits.maxAgentRuns ?? "No additional limit",
                  },
                ]}
              />
              {targets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Workflow code runs directly on the runner. No agent targets are granted.
                </p>
              ) : null}
            </div>
          </ConfigurationRow>
          <ConfigurationRow
            id="configuration-agent"
            title="What runs there"
            summary={summarizeAgents(agents, targets.length > 0)}
            detail={summarizeAgentOptions(agents)}
          >
            <AgentDetails manifest={manifest} inspection={inspection} />
          </ConfigurationRow>
          <ConfigurationRow
            id="configuration-github"
            title="GitHub access"
            summary={
              github.length > 0
                ? summarize(repositories) || "No repositories granted"
                : "No GitHub access"
            }
            detail={summarizeGitHub(manifest)}
          >
            <div className="grid min-w-0 gap-4">
              {github.length > 0 ? (
                github.map(([alias, grant]) => (
                  <SummaryPanel
                    key={alias}
                    layout="rows"
                    label={alias + " permissions"}
                    rows={[
                      { label: "Grant", value: alias },
                      { label: "Connection", value: grant.connection },
                      {
                        label: "Repositories",
                        value: grant.repositories.join(", ") || "No repositories granted",
                      },
                      ...Object.entries(grant.permissions).map(([name, value]) => ({
                        label: name,
                        value,
                      })),
                    ]}
                  />
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No GitHub access is granted to this workflow.
                </p>
              )}
              {manifest.grants.secrets?.length ? (
                <SummaryPanel
                  layout="rows"
                  label="Runner secrets"
                  rows={[{ label: "Runner secrets", value: manifest.grants.secrets.join(", ") }]}
                />
              ) : null}
            </div>
          </ConfigurationRow>
        </div>
      </Card>
    </Section>
  );
}

function EventConfiguration({ subscription }: { subscription: TriggerSubscription }) {
  return (
    <SummaryPanel
      label="Trigger event configuration"
      rows={[
        { label: "When this happens", value: subscriptionSummary(subscription) },
        ...(subscription.source === "manual"
          ? [{ label: "Starts", value: subscriptionDescription(subscription) }]
          : []),
        ...(subscription.connection
          ? [{ label: "Connection", value: subscription.connection }]
          : []),
        ...(subscription.resource
          ? [
              {
                label: subscriptionScopeLabel(subscription.source),
                value: subscription.resource,
              },
            ]
          : []),
      ]}
    />
  );
}

function AgentConfiguration({ agent }: { agent: InspectedAgent }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const label = agent.id.status === "known" ? (agent.id.value ?? "Agent call") : "Agent call";
  return (
    <div className="grid min-w-0 gap-3 py-4 first:pt-0 last:pb-0">
      <SummaryPanel
        layout="rows"
        label={label + " agent configuration"}
        rows={[
          { label: "Agent call", value: label },
          { label: "Model", value: fieldSummary(agent.model, "Provider default") },
          { label: "Provider", value: fieldSummary(agent.provider, "Not specified") },
          { label: "Execution mode", value: fieldSummary(agent.mode, "Provider default") },
          { label: "Thinking", value: fieldSummary(agent.thinking, "Provider default") },
          ...[
            { label: "Execution target", field: agent.target },
            { label: "GitHub grant", field: agent.github },
            { label: "Maximum runtime", field: agent.maxRuntime },
            { label: "Idle timeout", field: agent.idleTimeout },
            { label: "Startup timeout", field: agent.startupTimeout },
          ]
            .filter(({ field }) => field.status !== "unset")
            .map(({ label: fieldLabel, field }) => ({
              label: fieldLabel,
              value: fieldSummary(field, "Not specified"),
            })),
        ]}
      />
      <Disclosure
        variant="row"
        id={
          "agent-prompt-" + agent.source.path + "-" + agent.source.line + "-" + agent.source.column
        }
        title="Prompt"
        description={agent.prompt.status === "known" ? "View instructions" : "Computed at runtime"}
        open={promptOpen}
        onOpenChange={setPromptOpen}
      >
        <CodeBlock label={label + " prompt"}>
          {agent.prompt.value ?? agent.prompt.expression ?? "Not specified"}
        </CodeBlock>
      </Disclosure>
    </div>
  );
}

function ConfigurationRow({
  id,
  title,
  summary,
  detail,
  children,
}: {
  id: string;
  title: string;
  summary: string;
  detail?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      variant="row"
      id={id}
      title={title}
      description={summary}
      {...(detail ? { detail } : {})}
      open={open}
      onOpenChange={setOpen}
    >
      {open ? children : null}
    </Disclosure>
  );
}

function summarize(values: readonly string[], limit = 2): string {
  const entries = [...new Set(values)];
  return (
    entries.slice(0, limit).join(" · ") +
    (entries.length > limit ? " · +" + (entries.length - limit) + " more" : "")
  );
}

function summarizeGitHub(manifest: TriggerManifest): string {
  const grants = Object.entries(manifest.grants.github ?? {});
  if (grants.length === 0) {
    return manifest.grants.secrets?.length
      ? "Runner secrets: " + summarize(manifest.grants.secrets)
      : "No runner secrets requested";
  }
  return summarize(
    grants.map(([alias, grant]) => {
      const permissions = Object.entries(grant.permissions).map(
        ([name, value]) => name + ": " + value,
      );
      const connection = (grants.length > 1 ? alias + " · " : "Connection: ") + grant.connection;
      return [connection, summarize(permissions, 4)].filter(Boolean).join(" · ");
    }),
  );
}

function fieldSummary(field: CodeField, fallback: string): string {
  return field.status === "runtime" ? "Computed at runtime" : (field.value ?? fallback);
}

function summarizeAgents(agents: InspectedAgent[], hasTargets: boolean): string {
  if (agents.length === 0) return hasTargets ? "Defined in workflow code" : "Workflow script";
  const configurations = agents.map((agent) =>
    [
      fieldSummary(agent.provider, "Provider not specified"),
      fieldSummary(agent.model, "Provider default model"),
    ].join(" · "),
  );
  return (agents.length > 1 ? agents.length + " agent calls · " : "") + summarize(configurations);
}

function summarizeAgentOptions(agents: InspectedAgent[]): string {
  return summarize(
    agents.map((agent) =>
      [
        "Mode: " + fieldSummary(agent.mode, "Provider default"),
        agent.thinking.status === "unset"
          ? null
          : "Thinking: " + fieldSummary(agent.thinking, "Provider default"),
        agent.maxRuntime.status === "unset"
          ? null
          : "Runtime: " + fieldSummary(agent.maxRuntime, "Not specified"),
        agent.idleTimeout.status === "unset"
          ? null
          : "Idle: " + fieldSummary(agent.idleTimeout, "Not specified"),
      ]
        .filter(Boolean)
        .join(" · "),
    ),
  );
}

function AgentDetails({
  manifest,
  inspection,
}: {
  manifest: TriggerManifest;
  inspection: TriggerInspection | null;
}) {
  const targets = Object.keys(manifest.grants.targets ?? {});
  return (
    <div className="grid min-w-0 gap-3">
      {inspection && inspection.agents.length > 0 ? (
        <div className="grid min-w-0 divide-y divide-border">
          {inspection.agents.map((agent) => (
            <AgentConfiguration
              key={agent.source.path + ":" + agent.source.line + ":" + agent.source.column}
              agent={agent}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {targets.length === 0
            ? "Workflow code runs directly on the runner."
            : "Agent configuration is unavailable."}
        </p>
      )}
      {inspection?.limited ? (
        <p className="text-xs text-muted-foreground">Some configuration values are unavailable.</p>
      ) : null}
    </div>
  );
}
