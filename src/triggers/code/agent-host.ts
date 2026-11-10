/* oxlint-disable complexity, oxc/no-map-spread -- Bind one validated agent request to an immutable compiled execution contract. */
import type { Database } from "../../db/types.js";
import { compileHubConfig, parseDurationMs } from "../../config/compiler.js";
import { resolveTriggerConfigurationForOrganization } from "../../configuration/store.js";
import type { DaemonAgentConfigurationValidator } from "../../configuration/store.js";
import type { GitHubAuthorityRegistration } from "../../providers/registration.js";
import type { CodeRun } from "./records.js";
import { digest, CodeAgentOptionsSchema, ownGrant } from "./contract.js";
import {
  object,
  TriggerCodeError,
  TriggerAgentUnavailableError,
  type TriggerCodeAgentHost,
} from "./service.js";

export function createTriggerCodeAgentHost(input: {
  database: Database;
  validator: DaemonAgentConfigurationValidator;
  isDaemonConnected(id: string): boolean;
  wake(): Promise<void>;
  cancelExecutions(ids: readonly string[], reason: string): Promise<void>;
  githubAuthority?: GitHubAuthorityRegistration;
}): TriggerCodeAgentHost {
  const database = input.database;
  return {
    async ensure(run, operation, artifact) {
      const childId = operation.childRunId;
      if (childId === null) throw new Error("Agent operation has no durable child identity");
      await database.withAdvisoryLock(`trigger-code-agent:${childId}`, async () => {
        if ((await database.findTriggerRunById(childId)) !== undefined) return;
        const parent = await database.triggerCode.transaction(run.organizationId, (tx) =>
          tx.getRun(run.id),
        );
        if (
          !parent ||
          ["succeeded", "failed", "timed_out", "cancelled", "skipped"].includes(parent.status)
        )
          throw new Error("Parent Trigger is terminal");
        const trigger = (await database.listOrganizationTriggers(run.organizationId)).find(
          (item) => item.id === run.triggerId,
        );
        if (trigger === undefined) throw new Error("Parent Trigger not found");
        const options = CodeAgentOptionsSchema.parse(operation.input);
        const target = ownGrant(artifact.manifest.grants.targets, options.target);
        if (target === undefined) throw new TriggerCodeError("Agent target is not granted", 403);
        const remaining = Date.parse(run.deadlineAt) - Date.now();
        if (remaining <= 0) throw new Error("Parent Trigger deadline exceeded");
        const requestedRuntime = parseDurationMs(options.maxRuntime, "agent.maxRuntime");
        const github =
          options.github === undefined
            ? undefined
            : ownGrant(artifact.manifest.grants.github, options.github);
        const compiled = compileHubConfig({
          environments: [
            {
              name: "target",
              kind: "daemon",
              daemon: target.daemon,
              cwd: target.cwd,
              ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
            },
          ],
          triggers: [
            {
              name: artifact.manifest.name,
              on: "manual.run",
              max_runtime: `${Math.min(remaining, requestedRuntime)}ms`,
              filters: { from_users: ["*"] },
              steps: [
                {
                  id: "run",
                  environment: "target",
                  max_runtime: `${Math.min(remaining, requestedRuntime)}ms`,
                  idle_timeout: options.idleTimeout,
                  ...(options.startupTimeout === undefined
                    ? {}
                    : { startup_timeout: options.startupTimeout }),
                  agent: options.agent,
                  // Prompt text is carried literally below; the legacy template compiler only sees this placeholder.
                  prompt: [{ text: "Trigger code agent invocation" }],
                  ...(options.title === undefined ? {} : { title: options.title }),
                  ...(target.env === undefined ? {} : { env: target.env }),
                  ...(github === undefined ? {} : { github }),
                  ...(options.output === undefined ? {} : { output: options.output }),
                  ...(options.outputs === undefined
                    ? {}
                    : {
                        allow_outputs: Object.entries(options.outputs).map(([type, policy]) => ({
                          type,
                          ...policy,
                        })),
                      }),
                  auto_archive: options.autoArchive ?? true,
                  background: options.background ?? false,
                },
              ],
            },
          ],
        });
        const resolved = await resolveTriggerConfigurationForOrganization(
          database,
          run.organizationId,
          compiled,
        );
        if (!resolved.success)
          throw new Error(resolved.issues.map((issue) => issue.message).join("; "));
        const environment = resolved.configuration.environments[0];
        if (environment?.kind !== "daemon" || environment.daemonId === undefined)
          throw new Error("Agent daemon target was not resolved");
        if (!input.isDaemonConnected(environment.daemonId)) return;
        const validation = await input.validator
          .validateAgentConfiguration(environment.daemonId, options.agent)
          .catch(() => {
            throw new TriggerAgentUnavailableError();
          });
        if (!input.isDaemonConnected(environment.daemonId)) return;
        if (!validation.valid)
          throw new Error(validation.issues.map((issue) => issue.message).join("; "));
        const configuration = {
          ...resolved.configuration,
          triggers: resolved.configuration.triggers.map((item) => ({
            ...item,
            steps: item.steps.map((step) => ({
              ...step,
              literalPrompt: true,
              prompt: [{ kind: "text" as const, value: options.prompt }],
              continuation:
                options.continuation === undefined
                  ? { mode: "new" as const }
                  : { mode: "key" as const, key: options.continuation.key },
            })),
          })),
        };
        const revision = await database.insertProjectConfigurationRevision({
          projectId: trigger.runtimeProjectId,
          sourceKind: "manual",
          sourceEvidence: {
            kind: "trigger_code_agent",
            parentRunId: run.id,
            operationId: operation.id,
          },
          normalizedConfiguration: configuration,
          contentHash: digest(configuration),
          createdByUserId: null,
        });
        const receipt = await database.persistManualEvent({
          organizationId: run.organizationId,
          projectId: trigger.runtimeProjectId,
          source: "manual.run",
          deliveryId: `trigger-code-agent:${childId}`,
          receivedAt: new Date(),
          payload: { triggerCodeRunId: run.id, operationId: operation.id },
        });
        const receiptId =
          receipt.status === "accepted"
            ? receipt.event.providerEventReceiptId
            : receipt.providerEventReceiptId;
        await database.createAcceptedTriggerRun({
          id: childId,
          organizationId: run.organizationId,
          projectId: trigger.runtimeProjectId,
          configurationRevisionId: revision.id,
          providerEventReceiptId: receiptId,
          configuredTriggerName: artifact.manifest.name,
          idempotencyKey: `trigger-code-agent:${run.id}:${operation.id}`,
          prompt: options.prompt,
          inputs: {},
          triggerContext: { provider: "trigger_code", parentRunId: run.id },
          outputContext: await outputContext(database, run),
          deadlineAt: new Date(Math.min(Date.parse(run.deadlineAt), Date.now() + requestedRuntime)),
          stepIds: ["run"],
        });
      });
      await input.wake();
    },
    async cancel(runId, reason) {
      await database.withAdvisoryLock(`trigger-code-agent:${runId}`, async () => {
        const run = await database.findTriggerRunById(runId);
        if (run === undefined) return;
        const steps = await database.listWorkflowStepRunsForTriggerRun(runId);
        await input.cancelExecutions(
          steps.flatMap((step) => (step.agentExecutionId === null ? [] : [step.agentExecutionId])),
          reason,
        );
        if ((await database.findTriggerRunById(runId))?.status === "running")
          await database.failWorkflowRun(runId, "failed", reason);
      });
    },
    async github(run, artifact, request) {
      const value = object(request);
      const grant = ownGrant(artifact.manifest.grants.github, String(value["grant"]));
      if (grant === undefined || input.githubAuthority === undefined)
        throw new Error("Granted GitHub authority is unavailable");
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(String(value["method"])))
        throw new TriggerCodeError("Unsupported GitHub HTTP method");
      const trigger = (await database.listOrganizationTriggers(run.organizationId)).find(
        (item) => item.id === run.triggerId,
      );
      if (trigger === undefined) throw new Error("Parent Trigger not found");
      const lease = await input.githubAuthority.mint({
        projectId: trigger.runtimeProjectId,
        connectionSlug: grant.connection,
        repositories: grant.repositories,
        permissions: grant.permissions,
      });
      try {
        const response = await fetch(`https://api.github.com${String(value["path"])}`, {
          method: String(value["method"]),
          headers: {
            authorization: `Bearer ${lease.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2026-03-10",
            "content-type": "application/json",
          },
          ...(value["body"] === undefined ? {} : { body: JSON.stringify(value["body"]) }),
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.min(15_000, Math.max(1, Date.parse(run.deadlineAt) - Date.now())),
          ),
        });
        if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}`);
        const body = await response.text();
        if (Buffer.byteLength(body) > 1024 * 1024)
          throw new Error("GitHub response exceeds 1 MiB; paginate the request");
        return body.length === 0 ? null : (JSON.parse(body) as unknown);
      } finally {
        await input.githubAuthority.revoke(lease.token);
      }
    },
  };
}

async function outputContext(database: Database, run: CodeRun): Promise<unknown> {
  const raw = object(run.event.payload);
  if (run.event.source === "github") {
    const repository = object(raw["repository"]);
    const item = object(raw["pull_request"] ?? raw["issue"]);
    return {
      provider: "github",
      target: {
        installationId: object(raw["installation"])["id"],
        repository: repository["full_name"],
      },
      event: {
        github: { item: typeof item["number"] === "number" ? { number: item["number"] } : null },
      },
    };
  }
  // Provider-specific output recipients are materialized from the verified event, never a prompt.
  const usage = await database.organizationConnectionUsage(run.organizationId);
  if (run.event.source === "slack") {
    const connection = usage.slack.find((item) => item.slug === run.event.connection);
    return { provider: "slack", connectionId: connection?.id, ...raw };
  }
  if (run.event.source === "discord" || run.event.source === "linear")
    return { provider: run.event.source, ...raw };
  return { provider: "trigger_code" };
}
