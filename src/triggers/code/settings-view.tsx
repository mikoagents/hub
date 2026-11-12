/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-array-as-prop, eslint-plugin-react-perf/jsx-no-jsx-as-prop -- configuration records project code values into shared summary components */
import { Fragment, useId, useState, type ReactNode } from "react";
import { Braces, KeyRound, Server } from "lucide-react";
import {
  AgentProviderMark,
  agentProviderLabel,
} from "../../components/app/agent-provider-logos.js";
import { Card } from "../../components/app/card.js";
import { CodeBlock, InlineCode } from "../../components/app/copy-field.js";
import { Disclosure } from "../../components/app/disclosure.js";
import { RecordList, RecordRow } from "../../components/app/record-list.js";
import { Section } from "../../components/app/section.js";
import { SummaryPanel, type SummaryRow } from "../../components/app/summary-panel.js";
import { TwoLine } from "../../components/app/two-line.js";
import { ProviderGlyph } from "../../connections/provider-glyph.js";
import type { TriggerManifest } from "./sdk.js";
import type { CodeField, InspectedAgent, TriggerInspection } from "./inspection-types.js";
import {
  choiceSeparator,
  codeLine,
  eventRecords,
  fixedValues,
  githubAccess,
  oneOf,
} from "./presentation.js";

/**
 * What the deployed code declares, read top to bottom as the run does: what starts it, where it
 * runs, which agents it calls, and what it may touch. Every group is open — the configuration is
 * the page's subject, not a detail to dig for — and only prompts, which can run to pages, fold.
 */
export function TriggerSettings({
  manifest,
  inspection,
  version,
}: {
  manifest: TriggerManifest;
  inspection: TriggerInspection | null;
  version: number;
}) {
  return (
    <Section>
      <Card
        title="Configuration"
        description={`Defined in code, revision ${version}. Deploy a new revision to change it.`}
      >
        <SummaryPanel
          layout="groups"
          label="Trigger configuration"
          rows={[
            { label: "Events", value: <Events manifest={manifest} /> },
            { label: "Runs on", value: <RunsOn manifest={manifest} /> },
            {
              label: "Agent calls",
              value: <AgentCalls manifest={manifest} inspection={inspection} />,
            },
            { label: "Access", value: <Access manifest={manifest} /> },
          ]}
        />
      </Card>
    </Section>
  );
}

function Events({ manifest }: { manifest: TriggerManifest }) {
  const records = eventRecords(manifest.on);
  if (records.length === 0) return <None>No events start this Trigger.</None>;
  return (
    <RecordList label="Events">
      {records.map((record) => (
        <RecordRow key={record.key} media={<SourceGlyph source={record.source} />}>
          <TwoLine wrap primary={record.primary} secondary={record.secondary} />
        </RecordRow>
      ))}
    </RecordList>
  );
}

function RunsOn({ manifest }: { manifest: TriggerManifest }) {
  const targets = Object.entries(manifest.grants.targets ?? {});
  return (
    <RecordList label="Runs on">
      <RecordRow
        media={<Braces aria-hidden="true" />}
        details={
          <SummaryPanel
            layout="facts"
            label="Workflow runner"
            rows={[
              { label: "Time limit", value: manifest.limits.maxRuntime },
              {
                label: "Agent call limit",
                value:
                  manifest.limits.maxAgentRuns === undefined
                    ? "No limit"
                    : String(manifest.limits.maxAgentRuns),
              },
            ]}
          />
        }
      >
        <TwoLine primary={manifest.runner} secondary="Workflow runner" />
      </RecordRow>
      {targets.map(([alias, target]) => (
        <RecordRow
          key={alias}
          media={<Server aria-hidden="true" />}
          details={
            <SummaryPanel
              layout="facts"
              label={alias + " execution target"}
              rows={[
                { label: "Target", value: <Name>{alias}</Name> },
                {
                  label: "Providers",
                  value: target.providers.map(agentProviderLabel).join(", ") || "None",
                },
              ]}
            />
          }
        >
          <TwoLine path primary={target.daemon} secondary={target.cwd} />
        </RecordRow>
      ))}
    </RecordList>
  );
}

function AgentCalls({
  manifest,
  inspection,
}: {
  manifest: TriggerManifest;
  inspection: TriggerInspection | null;
}) {
  const agents = inspection?.agents ?? [];
  const targets = Object.keys(manifest.grants.targets ?? {});
  return (
    <div className="grid min-w-0 gap-3">
      {agents.length > 0 ? (
        <RecordList label="Agent calls">
          {agents.map((agent) => (
            <AgentCall
              key={agent.source.path + ":" + agent.source.line + ":" + agent.source.column}
              agent={agent}
            />
          ))}
        </RecordList>
      ) : (
        <None>
          {targets.length === 0
            ? "None. The workflow code runs without agents."
            : "No agent calls could be read from the code."}
        </None>
      )}
      {inspection?.limited ? (
        <p className="text-xs text-muted-foreground">
          Part of the code couldn't be read, so this list may be incomplete.
        </p>
      ) : null}
    </div>
  );
}

function AgentCall({ agent }: { agent: InspectedAgent }) {
  const id = useId();
  const [promptOpen, setPromptOpen] = useState(false);
  const name = callName(agent.id);
  const providers = fixedValues(agent.provider);
  // A call that picks between providers has no one mark to show.
  const provider = providers.length === 1 ? providers[0] : undefined;
  const facts: SummaryRow[] = [
    { label: "Mode", value: <Setting field={agent.mode} fallback="Provider default" /> },
    { label: "Thinking", value: <Setting field={agent.thinking} fallback="Provider default" /> },
    { label: "Target", value: <Setting names field={agent.target} fallback="Not set" /> },
  ];
  if (agent.github.status !== "unset")
    facts.push({
      label: "GitHub access",
      value: <Setting names field={agent.github} fallback="Not set" />,
    });
  for (const [label, field] of [
    ["Time limit", agent.maxRuntime],
    ["Idle timeout", agent.idleTimeout],
    ["Startup timeout", agent.startupTimeout],
  ] as const) {
    if (field.status !== "unset")
      facts.push({ label, value: <Setting field={field} fallback="Not set" /> });
  }
  return (
    <RecordRow
      media={<AgentProviderMark provider={provider ?? ""} />}
      details={
        <div className="grid min-w-0 gap-3">
          <SummaryPanel layout="facts" label={name + " agent configuration"} rows={facts} />
          <Disclosure
            variant="inline"
            id={id}
            title="Prompt"
            description={promptPreview(agent.prompt)}
            open={promptOpen}
            onOpenChange={setPromptOpen}
          >
            {promptOpen ? <Prompt name={name} field={agent.prompt} /> : null}
          </Disclosure>
        </div>
      }
    >
      <TwoLine
        primary={agent.id.status === "runtime" ? <InlineCode>{name}</InlineCode> : name}
        secondary={<AgentModel agent={agent} />}
      />
    </RecordRow>
  );
}

function Prompt({ name, field }: { name: string; field: CodeField }) {
  if (field.status === "known")
    return <CodeBlock label={name + " prompt"}>{field.value ?? ""}</CodeBlock>;
  if (field.status === "unset") return <None>No prompt is set.</None>;
  if (field.status === "choice")
    return (
      <div className="grid min-w-0 gap-2">
        <p className="text-xs text-muted-foreground">
          One of these, picked when the workflow runs:
        </p>
        {field.values.map((value, index) => (
          <CodeBlock key={value} label={`${name} prompt ${index + 1}`}>
            {value}
          </CodeBlock>
        ))}
      </div>
    );
  return (
    <div className="grid min-w-0 gap-2">
      <p className="text-xs text-muted-foreground">Built when the workflow runs, from:</p>
      <CodeBlock label={name + " prompt"}>{field.expression ?? ""}</CodeBlock>
    </div>
  );
}

function Access({ manifest }: { manifest: TriggerManifest }) {
  const connections = githubAccess(manifest.grants.github ?? {});
  const secrets = manifest.grants.secrets ?? [];
  if (connections.length === 0 && secrets.length === 0)
    return <None>None. The workflow can't reach GitHub or runner secrets.</None>;
  return (
    <RecordList label="Access">
      {connections.map((access) => (
        <RecordRow
          key={access.connection}
          media={<ProviderGlyph provider="github" />}
          details={
            <div className="grid min-w-0 gap-3">
              <SummaryPanel
                layout="names"
                label={access.connection + " grants"}
                rows={access.grants.map((grant) => ({
                  label: grant.alias,
                  value: grant.repositories.join(", ") || "No repositories",
                }))}
              />
              <SummaryPanel
                layout="facts"
                label={access.connection + " permissions"}
                rows={access.permissions.map((permission) => ({
                  label: permission.label,
                  value: permission.shared ?? <Levels levels={permission.levels} />,
                }))}
              />
            </div>
          }
        >
          <TwoLine primary={access.connection} secondary="GitHub connection" />
        </RecordRow>
      ))}
      {secrets.length > 0 ? (
        <RecordRow media={<KeyRound aria-hidden="true" />}>
          <TwoLine mono primary="Runner secrets" secondary={secrets.join(", ")} />
        </RecordRow>
      ) : null}
    </RecordList>
  );
}

/** A permission whose level differs between grants, as each grant has it. */
function Levels({ levels }: { levels: readonly { alias: string; level: string }[] }) {
  return (
    <span className="grid">
      {levels.map((entry) => (
        <span key={entry.alias}>
          <Name>{entry.alias}</Name> {entry.level}
        </span>
      ))}
    </span>
  );
}

/** The names agent calls use for a target or a grant, set as the code spells them. */
function Name({ children }: { children: string }) {
  return <span className="font-mono text-xs">{children}</span>;
}

/**
 * A setting as the code has it: its value, the values it picks between when the workflow runs, or
 * the code that computes it then. `names` sets values as the code spells them — targets, grants.
 */
function Setting({
  field,
  fallback,
  names = false,
}: {
  field: CodeField;
  fallback: string;
  names?: boolean;
}) {
  if (field.status === "runtime")
    return <InlineCode>{codeLine(field.expression ?? "")}</InlineCode>;
  const values = fixedValues(field);
  if (values.length === 0) return fallback;
  if (!names) return oneOf(values);
  return values.map((value, index) => (
    <Fragment key={value}>
      <Name>{value}</Name>
      {choiceSeparator(index, values.length)}
    </Fragment>
  ));
}

function None({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

const KNOWN_SOURCES = ["github", "discord", "slack", "linear", "manual", "schedule"] as const;

function SourceGlyph({ source }: { source: string }) {
  const known = KNOWN_SOURCES.find((candidate) => candidate === source);
  return known === undefined ? <Braces aria-hidden="true" /> : <ProviderGlyph provider={known} />;
}

/** What a call is called in labels: its id, the ids it picks between, or the code that names it. */
function callName(field: CodeField): string {
  if (field.status === "runtime") return codeLine(field.expression ?? "");
  return oneOf(fixedValues(field)) || "Agent call";
}

function AgentModel({ agent }: { agent: InspectedAgent }) {
  const providers = fixedValues(agent.provider);
  return (
    <>
      {providers.length > 0 ? (
        oneOf(providers.map(agentProviderLabel))
      ) : (
        <Setting field={agent.provider} fallback="Provider not set" />
      )}
      {" · "}
      <Setting field={agent.model} fallback="Default model" />
    </>
  );
}

/** The prompt's first line, enough to tell two agent calls apart without opening either. */
function promptPreview(field: CodeField): ReactNode {
  if (field.status === "unset") return "Not set";
  if (field.status !== "known") return <InlineCode>{codeLine(field.expression ?? "")}</InlineCode>;
  const line = (field.value ?? "").trim().split("\n", 1)[0] ?? "";
  return line.length > 160 ? line.slice(0, 159) + "…" : line;
}
