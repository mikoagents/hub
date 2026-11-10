import { validateArtifact, jsonValue } from "./code/contract.js";
import { inspectTriggerArtifact } from "./code/inspection.js";
import { agentModelSummary } from "./code/presentation.js";
import type { TriggerCodeService } from "./code/service.js";
import type { CodeRun } from "./code/records.js";
import { randomUUID } from "node:crypto";
import { SessionTimelines } from "../session-timelines/service.js";
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
    private readonly sessionTimelines?: SessionTimelines,
    private readonly triggerCode?: TriggerCodeService | null,
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
    const codeRuns = await this.database.triggerCode.transaction(tenant.organization.id, (tx) =>
      tx.listRuns(undefined, 100),
    );
    const codeActivity = codeRuns.map((run) =>
      codeActivityView(
        run,
        triggers.find((trigger) => trigger.id === run.triggerId)?.name ?? "Trigger",
      ),
    );
    const activity = (
      await Promise.all(triggers.map((trigger) => this.activityForTrigger(trigger)))
    )
      .flat()
      .concat(codeActivity)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, 100);
    return {
      organization: tenant.organization,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      triggers: await Promise.all(
        triggers.map(async (trigger) => {
          let latest = activity.find(({ triggerId }) => triggerId === trigger.id);
          if (latest?.code !== true && trigger.format === "code") {
            const run = await this.database.triggerCode.transaction(
              tenant.organization.id,
              async (tx) => (await tx.listRuns(trigger.id, 1))[0],
            );
            if (run && (latest === undefined || run.createdAt > latest.receivedAt))
              latest = codeActivityView(run, trigger.name);
          }
          return triggerView(store, trigger, latest);
        }),
      ),
      activity,
      // Only a daemon that can run agents is a target; one enrolled without `hub.execute` would
      // be refused at save, and Home says how to grant it.
      daemons: daemons
        .filter(
          ({ status, permissions }) => status === "active" && permissions.includes("hub.execute"),
        )
        .map(({ id, slug, presence, connectedAt }) => ({
          id,
          slug,
          presence,
          connectedAt: connectedAt?.toISOString() ?? null,
        })),
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

  async triggerHistory(request: Request, organizationSlug: string, triggerId: string) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const trigger = (await this.database.listOrganizationTriggers(tenant.organization.id)).find(
      (item) => item.id === triggerId,
    );
    if (!trigger) throw new ProjectCommandError("run_unavailable");
    const [historical, codeRuns] = await Promise.all([
      this.activityForTrigger(trigger),
      this.database.triggerCode.transaction(tenant.organization.id, (tx) =>
        tx.listRuns(trigger.id, 100),
      ),
    ]);
    return historical
      .concat(codeRuns.map((run) => codeActivityView(run, trigger.name)))
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, 100);
  }

  private async activityForTrigger(trigger: OrganizationTriggerRecord) {
    const migrationRevision = await this.database.findOrganizationTriggerMigrationRevision(
      trigger.id,
    );
    const evidence = record(migrationRevision?.sourceEvidence);
    const legacyProjectId = string(evidence?.["legacyProjectId"]);
    const legacyTriggerName =
      migrationRevision === undefined || legacyProjectId === undefined
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
          record(run.triggerContext)?.["provider"] !== "trigger_code" &&
          (current.some((candidate) => candidate.run.id === run.id) ||
            run.configuredTriggerName === legacyTriggerName),
      )
      .map(
        ({ run, receipt }): TriggerActivityRow => ({
          id: run.id,
          triggerId: trigger.id,
          triggerName: trigger.name,
          provider: receipt.provider,
          source: receipt.source,
          repo: receipt.repo,
          status: run.status,
          code: false,
          failureReason:
            run.outcome === "accepted" ? displayFailureReason(run.failureReason) : null,
          receivedAt: receipt.receivedAt.toISOString(),
        }),
      );
  }

  private async resolveActivity(
    request: Request,
    scope: { organizationSlug: string; triggerId: string; runId: string; executionId?: string },
  ): Promise<{ trigger: OrganizationTriggerRecord; activity: ProjectActivityRunRecord }> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, scope);
    const trigger = (await this.database.listOrganizationTriggers(tenant.organization.id)).find(
      ({ id }) => id === scope.triggerId,
    );
    if (trigger === undefined) throw new ProjectCommandError("run_unavailable");
    const code = await this.database.triggerCode.transaction(tenant.organization.id, async (tx) => {
      const run = await tx.getRun(scope.runId);
      return run?.triggerId === trigger.id ? tx.operations(run.id) : [];
    });
    for (const operation of code) {
      if (operation.childRunId === null) continue;
      const child = await this.database.findProjectActivityRun(
        trigger.runtimeProjectId,
        operation.childRunId,
      );
      if (
        child &&
        (scope.executionId === undefined ||
          child.steps.some((step) => step.agentExecutionId === scope.executionId))
      )
        return { trigger, activity: child };
    }
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

  async activityRunTimeline(
    request: Request,
    scope: {
      organizationSlug: string;
      triggerId: string;
      runId: string;
      executionId: string;
      before?: number | undefined;
    },
  ) {
    const { activity } = await this.resolveActivity(request, scope);
    if (!activity.steps.some((step) => step.agentExecutionId === scope.executionId))
      throw new ProjectCommandError("run_unavailable");
    const execution = await this.database.findAgentExecutionForProject(
      activity.run.projectId,
      scope.executionId,
    );
    if (!execution || execution.organizationId !== activity.run.organizationId)
      throw new ProjectCommandError("run_unavailable");
    const session = execution.agentSessionId
      ? await this.database.findAgentSession(execution.agentSessionId)
      : undefined;
    if (
      session &&
      (session.organizationId !== execution.organizationId ||
        session.projectId !== execution.projectId)
    )
      throw new ProjectCommandError("run_unavailable");
    if (!session || !this.sessionTimelines)
      return {
        sessionId: null,
        unavailableReason: "This execution has no readable session reference.",
        state: null,
        rows: [],
        availability: "unavailable" as const,
        hasOlder: false,
      };
    return {
      sessionId: session.id,
      ...(await this.sessionTimelines.read(session.id, scope.before)),
    };
  }

  async codeDetail(
    request: Request,
    organizationSlug: string,
    triggerId: string,
    revisionId?: string,
  ) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug,
    });
    const trigger = (await this.database.listOrganizationTriggers(tenant.organization.id)).find(
      (item) => item.id === triggerId,
    );
    if (!trigger) throw new ProjectCommandError("run_unavailable");
    const revision = await this.database.findOrganizationTriggerRevision(
      trigger.id,
      revisionId ?? trigger.activeRevisionId,
    );
    if (!revision) throw new ProjectCommandError("run_unavailable");
    const artifact =
      record(revision.sourceEvidence)?.["artifact"] !== undefined
        ? validateArtifact(record(revision.sourceEvidence)?.["artifact"])
        : null;
    return {
      id: trigger.id,
      canManage: capabilitiesFor(tenant.membership.role).manageResources,
      active: revision.id === trigger.activeRevisionId,
      revisions: (
        await this.database.listOrganizationTriggerRevisions(tenant.organization.id, trigger.id)
      ).map(({ id, version, contentHash, sourceKind, createdAt }) => ({
        id,
        version,
        contentHash,
        sourceKind,
        createdAt: createdAt.toISOString(),
      })),
      name: trigger.name,
      enabled: trigger.enabled,
      revisionId: revision.id,
      version: revision.version,
      artifact:
        artifact === null
          ? null
          : {
              manifest: artifact.manifest,
              sources: artifact.sources,
              entrypoint: artifact.entrypoint,
              digest: artifact.digest,
            },
      yaml: artifact === null ? revision.yaml : null,
      inspection: artifact === null ? null : inspectTriggerArtifact(artifact),
    };
  }

  async codeRunDetail(
    request: Request,
    scope: { organizationSlug: string; triggerId: string; runId: string },
  ) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, scope);
    const data = await this.database.triggerCode.transaction(tenant.organization.id, async (tx) => {
      const run = await tx.getRun(scope.runId);
      if (!run || run.triggerId !== scope.triggerId)
        throw new ProjectCommandError("run_unavailable");
      return { run, operations: await tx.operations(run.id), logs: await tx.logs(run.id) };
    });
    const operations = await Promise.all(
      data.operations.map(async (operation) => {
        const steps =
          operation.childRunId === null
            ? []
            : await this.database.listWorkflowStepRunsForTriggerRun(operation.childRunId);
        return {
          id: operation.id,
          kind: operation.kind,
          status: operation.status,
          input: jsonValue(operation.input),
          output: jsonValue(operation.output),
          error: operation.error,
          createdAt: operation.createdAt,
          executionId: steps[0]?.agentExecutionId ?? null,
        };
      }),
    );
    const { run } = data;
    return {
      run: {
        id: run.id,
        status: run.status,
        output: jsonValue(run.output),
        error: run.error,
        event: run.event,
        revisionId: run.revisionId,
        createdAt: run.createdAt,
        deadlineAt: run.deadlineAt,
        completedAt: run.completedAt,
      },
      operations,
      logs: data.logs.map((log) => ({
        id: log.id,
        time: log.time,
        message: log.message,
        data: jsonValue(log.data),
      })),
    };
  }

  async codeAction(
    request: Request,
    scope: {
      organizationSlug: string;
      triggerId: string;
      action: "run" | "enable" | "disable" | "cancel";
      runId?: string | undefined;
    },
  ) {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, scope);
    if (!capabilitiesFor(tenant.membership.role).manageResources || !this.triggerCode)
      throw new ProjectCommandError("forbidden");
    const trigger = await this.triggerCode.trigger(tenant.organization.id, scope.triggerId);
    if (scope.action === "cancel") {
      const run = await this.database.triggerCode.transaction(tenant.organization.id, (tx) =>
        tx.getRun(scope.runId ?? ""),
      );
      if (run?.triggerId !== trigger.id) throw new ProjectCommandError("run_unavailable");
      await this.triggerCode.cancel(tenant.organization.id, run.id);
    } else if (scope.action === "run") {
      await this.triggerCode.receive(tenant.organization.id, trigger.id, {
        id: randomUUID(),
        source: "manual",
        type: "run",
        payload: null,
        receivedAt: new Date().toISOString(),
      });
    } else
      await this.triggerCode.setEnabled(
        tenant.organization.id,
        trigger.id,
        scope.action === "enable",
      );
    return { state: "complete" as const };
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
  const artifact = trigger.format === "code" ? validateArtifact(evidence?.["artifact"]) : null;
  const code =
    artifact === null
      ? null
      : {
          manifest: artifact.manifest,
          digest: artifact.digest,
          version: revision.version,
          agentSummary: agentModelSummary(inspectTriggerArtifact(artifact)),
        };
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
      code,
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
    yaml: trigger.format === "code" ? "" : revision.yaml,
    code,
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

function codeActivityView(run: CodeRun, triggerName: string): TriggerActivityRow {
  return {
    id: run.id,
    triggerId: run.triggerId,
    triggerName,
    provider: run.event.source,
    source: `${run.event.source}.${run.event.type}`,
    repo: run.event.resource ?? null,
    status: run.status,
    failureReason: run.error,
    receivedAt: run.createdAt,
    code: true,
  };
}

export interface TriggerActivityRow {
  id: string;
  triggerId: string;
  triggerName: string;
  provider: string;
  source: string;
  repo: string | null;
  status: string;
  failureReason: string | null;
  receivedAt: string;
  code: boolean;
}
