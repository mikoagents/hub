import type { AuthServer } from "../auth/server.js";
import { capabilitiesFor } from "../auth/organization-policy.js";
import type { Database, OrganizationTriggerRecord, ProjectActivityRunRecord } from "../db/types.js";
import { activityRunView, displayFailureReason } from "../projects/dashboard.js";
import { resolveRouteTenant } from "../projects/access.js";
import { ProjectCommandError } from "../projects/command-error.js";
import { parseCompiledHubConfig } from "../config/compiler.js";
import type { DaemonAgentConfigurationValidator } from "../configuration/store.js";
import { projectTriggerForm } from "./configuration/editor.js";
import { OrganizationTriggerStore } from "./store.js";

export class TriggerDashboard {
  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly agentValidator: DaemonAgentConfigurationValidator,
  ) {}

  async snapshot(request: Request, organizationSlug: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const store = new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    );
    const [triggers, daemons, connections] = await Promise.all([
      store.list(),
      this.database.listDaemonsForOrganization(tenant.organization.id),
      this.database.organizationConnectionUsage(tenant.organization.id),
    ]);
    const activity = (
      await Promise.all(triggers.map((trigger) => this.activityForTrigger(trigger)))
    )
      .flat()
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, 100);
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      triggers: await Promise.all(
        triggers.map((trigger) =>
          triggerView(
            store,
            trigger,
            activity.find(({ triggerId }) => triggerId === trigger.id),
          ),
        ),
      ),
      activity,
      // Only a daemon that can run agents is a target; one enrolled without `hub.execute` would
      // be refused at save, and Home says how to grant it.
      daemons: daemons
        .filter(
          ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
        )
        .map(({ id, slug, presence }) => ({ id, slug, presence })),
      connections: [
        ...connections.slack.map(({ id, slug, teamName }) => ({
          id,
          slug,
          provider: "slack" as const,
          label: teamName,
        })),
        ...connections.discord.map(({ id, slug, guildName }) => ({
          id,
          slug,
          provider: "discord" as const,
          label: guildName,
        })),
        ...connections.github.map(({ id, slug, accountLogin }) => ({
          id,
          slug,
          provider: "github" as const,
          label: accountLogin,
        })),
        ...connections.linear.map(({ id, slug, linearOrganizationName }) => ({
          id,
          slug,
          provider: "linear" as const,
          label: linearOrganizationName,
        })),
      ],
    };
  }

  private async activityForTrigger(trigger: OrganizationTriggerRecord) {
    const migrationRevision = await this.database.findOrganizationTriggerMigrationRevision(
      trigger.id,
    );
    const evidence = record(migrationRevision?.sourceEvidence);
    const legacyProjectId = string(evidence?.["legacyProjectId"]);
    const legacyTriggerName =
      migrationRevision === undefined
        ? undefined
        : parseCompiledHubConfig(migrationRevision.normalizedConfiguration).triggers[0]?.name;
    const [current, historical] = await Promise.all([
      this.database.listProjectActivityRuns(trigger.runtimeProjectId, 100),
      legacyProjectId === undefined
        ? Promise.resolve([])
        : this.database.listProjectActivityRuns(legacyProjectId, 100),
    ]);
    return [...current, ...historical]
      .filter(
        ({ run }) =>
          current.some((candidate) => candidate.run.id === run.id) ||
          run.configuredTriggerName === legacyTriggerName,
      )
      .map(({ run, receipt }) => ({
        id: run.id,
        triggerId: trigger.id,
        triggerName: trigger.name,
        provider: receipt.provider,
        source: receipt.source,
        repo: receipt.repo,
        status: run.status,
        failureReason: run.outcome === "accepted" ? displayFailureReason(run.failureReason) : null,
        receivedAt: receipt.receivedAt.toISOString(),
      }));
  }

  private async resolveActivity(
    request: Request,
    scope: { organizationSlug: string; triggerId: string; runId: string },
  ): Promise<{ trigger: OrganizationTriggerRecord; activity: ProjectActivityRunRecord }> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, scope);
    const trigger = (await this.database.listOrganizationTriggers(tenant.organization.id)).find(
      ({ id }) => id === scope.triggerId,
    );
    if (trigger === undefined) throw new ProjectCommandError("run_unavailable");
    const current = await this.database.findProjectActivityRun(
      trigger.runtimeProjectId,
      scope.runId,
    );
    if (current !== undefined && current.run.organizationId === tenant.organization.id) {
      return { trigger, activity: current };
    }
    const migration = await this.database.findOrganizationTriggerMigrationRevision(trigger.id);
    const legacyProjectId = string(record(migration?.sourceEvidence)?.["legacyProjectId"]);
    if (migration !== undefined && legacyProjectId !== undefined) {
      const historical = await this.database.findProjectActivityRun(legacyProjectId, scope.runId);
      const name = parseCompiledHubConfig(migration.normalizedConfiguration).triggers[0]?.name;
      if (
        historical !== undefined &&
        historical.run.organizationId === tenant.organization.id &&
        historical.run.configuredTriggerName === name
      )
        return { trigger, activity: historical };
    }
    throw new ProjectCommandError("run_unavailable");
  }

  async activityRunSnapshot(
    request: Request,
    scope: { organizationSlug: string; triggerId: string; runId: string },
  ) {
    const { trigger, activity } = await this.resolveActivity(request, scope);
    return {
      triggerName: trigger.name,
      activity: activityRunView(
        activity,
        await Promise.all(
          activity.steps.map(async (step) =>
            step.agentExecutionId === null
              ? undefined
              : this.database.findAgentExecutionForOrganization(
                  trigger.organizationId,
                  step.agentExecutionId,
                ),
          ),
        ),
      ),
    };
  }

  async activityRunLogs(
    request: Request,
    scope: {
      organizationSlug: string;
      triggerId: string;
      runId: string;
      executionId: string;
      after: string;
    },
  ) {
    const { activity } = await this.resolveActivity(request, scope);
    if (!activity.steps.some((step) => step.agentExecutionId === scope.executionId)) {
      throw new ProjectCommandError("run_unavailable");
    }
    const execution = await this.database.findAgentExecutionForProject(
      activity.run.projectId,
      scope.executionId,
    );
    if (execution === undefined || execution.organizationId !== activity.run.organizationId)
      throw new ProjectCommandError("run_unavailable");
    const entries = await this.database.listAgentExecutionLogs(scope.executionId, scope.after, 101);
    return {
      entries: entries.slice(0, 100).map((entry) => ({
        id: entry.id,
        executionId: entry.executionId,
        event: entry.event,
        recordedAt: entry.recordedAt.toISOString(),
      })),
      nextCursor: entries.length > 100 ? entries[99]!.id : null,
    };
  }

  async save(
    request: Request,
    organizationSlug: string,
    input: { triggerId?: string; yaml: string },
  ) {
    const { account, tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    if (!capabilitiesFor(tenant.membership.role).manageResources) {
      throw new ProjectCommandError("forbidden");
    }
    return new OrganizationTriggerStore(
      this.database,
      tenant.organization.id,
      this.agentValidator,
    ).save({
      ...(input.triggerId === undefined ? {} : { triggerId: input.triggerId }),
      yaml: input.yaml,
      userId: account.account.id,
    });
  }
}

async function triggerView(
  store: OrganizationTriggerStore,
  trigger: OrganizationTriggerRecord,
  lastTriggered:
    | { provider: string; source: string; status: string; receivedAt: string }
    | undefined,
) {
  const revision = await store.activeRevision(trigger);
  const evidence = record(revision.sourceEvidence);
  const event = triggerEvent(revision.yaml, lastTriggered?.source);
  const operational =
    lastTriggered === undefined
      ? null
      : { status: lastTriggered.status, receivedAt: lastTriggered.receivedAt };
  if (trigger.format === "legacy_multistep") {
    return {
      id: trigger.id,
      name: trigger.name,
      enabled: trigger.enabled,
      format: trigger.format,
      yaml: revision.yaml,
      updatedAt: trigger.updatedAt.toISOString(),
      blockers: stringArray(evidence?.["conversionBlockers"]),
      draft: null,
      event,
      provider: triggerProvider(event, lastTriggered?.provider),
      lastTriggered: operational,
    };
  }
  const projection = projectTriggerForm(revision.yaml);
  return {
    id: trigger.id,
    name: trigger.name,
    enabled: trigger.enabled,
    format: trigger.format,
    yaml: revision.yaml,
    updatedAt: trigger.updatedAt.toISOString(),
    blockers: [],
    draft: projection.status === "editable" ? projection.value : null,
    event: projection.status === "editable" ? projection.value.event : event,
    provider: triggerProvider(
      projection.status === "editable" ? projection.value.event : event,
      lastTriggered?.provider,
    ),
    lastTriggered: operational,
  };
}

function triggerEvent(yaml: string, fallback: string | undefined): string {
  const inline = /^on:\s+([a-z]+(?:\.[a-z_]+)+)\s*$/mu.exec(yaml)?.[1];
  if (inline !== undefined) return inline;
  const nested = /^on:\s*$[\s\S]*?^\s{2}([a-z]+(?:\.[a-z_]+)+):\s*$/mu.exec(yaml)?.[1];
  return nested ?? fallback ?? "manual.run";
}

function triggerProvider(
  event: string,
  fallback: string | undefined,
): "github" | "discord" | "slack" | "linear" | "manual" | "schedule" {
  const provider = event.split(".")[0] ?? fallback;
  if (
    provider === "schedule" ||
    provider === "github" ||
    provider === "discord" ||
    provider === "slack" ||
    provider === "linear"
  ) {
    return provider;
  }
  return "manual";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
