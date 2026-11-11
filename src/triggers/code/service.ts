/* oxlint-disable oxc/no-map-spread -- Deployment and API views preserve immutable revision snapshots. */
import { randomBytes, randomUUID } from "node:crypto";
import type {
  Database,
  DurableProviderEvent,
  OrganizationTriggerRecord,
  OrganizationTriggerRoute,
} from "../../db/types.js";
import { parseDurationMs, type CompiledHubConfig } from "../../config/compiler.js";
import { nextOccurrence } from "../schedule/recurrence.js";
import { reportFailure } from "../../failures/index.js";
import {
  CodeAgentOptionsSchema,
  jsonValue,
  ownGrant,
  digest,
  stableJson,
  subscribes,
  validateArtifact,
  matchesPattern,
  type TriggerArtifact,
} from "./contract.js";
import type { TriggerEvent, OperationRequest, OperationReply } from "./sdk.js";
import { errorFailure, type TriggerFailure } from "./sdk-errors.js";
import {
  terminal,
  type CodeRun,
  type CodeOperation,
  type CodeRunner,
  type TriggerCodeTransaction,
  type CodeRunStatus,
} from "./records.js";

const LEASE_MS = 30_000;
const MAX_VALUE_BYTES = 1024 * 1024;
export interface TriggerCodeAgentHost {
  ensure(run: CodeRun, operation: CodeOperation, artifact: TriggerArtifact): Promise<void>;
  cancel(runId: string, reason: string): Promise<void>;
  github(run: CodeRun, artifact: TriggerArtifact, request: unknown): Promise<unknown>;
}
export interface TriggerJob {
  run: CodeRun;
  leaseToken: string;
  artifact: TriggerArtifact;
}

export class TriggerCodeError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "TriggerCodeError";
  }
}

export class TriggerAgentUnavailableError extends Error {
  constructor() {
    super("Agent validation is temporarily unavailable");
    this.name = "TriggerAgentUnavailableError";
  }
}

/** Coordinates code; no user module is imported or evaluated in the Hub process. */
export class TriggerCodeService {
  private timer: NodeJS.Timeout | undefined;
  private processing: Promise<void> | undefined;
  constructor(
    readonly database: Database,
    private readonly host: TriggerCodeAgentHost,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async validate(organizationId: string, value: unknown) {
    let artifact: TriggerArtifact;
    try {
      artifact = validateArtifact(value);
    } catch (error) {
      throw new TriggerCodeError(errorMessage(error));
    }
    const usage = await this.database.organizationConnectionUsage(organizationId);
    const daemons = await this.database.listDaemonsForOrganization(organizationId);
    for (const target of Object.values(artifact.manifest.grants.targets ?? {})) {
      if (
        !daemons.some(
          (daemon) =>
            daemon.slug === target.daemon &&
            daemon.status === "active" &&
            daemon.permissions.includes("hub.execute"),
        )
      )
        throw new TriggerCodeError(`Daemon is unavailable or lacks hub.execute: ${target.daemon}`);
    }
    const routes: OrganizationTriggerRoute[] = [];
    for (const subscription of artifact.manifest.on) {
      if (!connectionProvider(subscription.source)) continue;
      const provider = subscription.source;
      const connection = usage[provider].find((item) => item.slug === subscription.connection);
      if (connection === undefined)
        throw new TriggerCodeError(`Connection is unavailable: ${subscription.connection}`);
      let resourceId: string | null = null;
      if (subscription.resource !== undefined) {
        if (provider === "github") {
          const repository = (await this.database.listGitHubRepositories(organizationId)).find(
            (item) =>
              item.connectionId === connection.id && item.fullName === subscription.resource,
          );
          if (repository === undefined)
            throw new TriggerCodeError(
              `GitHub repository is unavailable: ${subscription.resource}`,
            );
          resourceId = String(repository.repositoryId);
        } else resourceId = subscription.resource;
      }
      routes.push({
        provider,
        connectionId: connection.id,
        resourceId,
        configuredEventName: `${provider}.code`,
      });
    }
    for (const grant of Object.values(artifact.manifest.grants.github ?? {})) {
      if (!usage.github.some((item) => item.slug === grant.connection))
        throw new TriggerCodeError(`GitHub connection is unavailable: ${grant.connection}`);
      const repositories = await this.database.listGitHubRepositories(organizationId);
      if (
        grant.repositories.some(
          (repo) =>
            !repositories.some(
              (item) =>
                item.fullName === repo &&
                usage.github.some(
                  (connection) =>
                    connection.id === item.connectionId && connection.slug === grant.connection,
                ),
            ),
        )
      )
        throw new TriggerCodeError("GitHub grant references a repository outside its connection");
    }
    return {
      artifact,
      routes: routes.filter(
        (route, index) =>
          routes.findIndex((candidate) => stableJson(candidate) === stableJson(route)) === index,
      ),
    };
  }

  async deploy(
    organizationId: string,
    value: unknown,
    sourceEvidence: Record<string, unknown> = {},
  ) {
    const { artifact, routes } = await this.validate(organizationId, value);
    return this.database.withAdvisoryLock(
      `trigger-code-deploy:${organizationId}:${artifact.manifest.name}`,
      async () => {
        const previous = (await this.database.listOrganizationTriggers(organizationId)).find(
          (item) => item.name === artifact.manifest.name,
        );
        // The existing routing adapter remains data-only; code owns its dynamic operation graph.
        const routing: CompiledHubConfig = {
          environments: [{ kind: "daemon", name: "code", daemon: "trigger-runner", cwd: "/" }],
          triggers: [],
        };
        const trigger = await this.database.saveOrganizationTrigger({
          organizationId,
          ...(previous === undefined ? {} : { triggerId: previous.id }),
          name: artifact.manifest.name,
          enabled: previous?.enabled ?? true,
          format: "code",
          yaml: artifact.sources[0]?.content ?? "",
          normalizedConfiguration: routing,
          contentHash: artifact.digest,
          sourceKind: "manual",
          sourceEvidence: { ...sourceEvidence, kind: "trigger_code", artifact },
          createdByUserId: null,
          routes: previous?.enabled === false ? [] : routes,
        });
        // Also establishes the organization in the in-memory repository used by tests.
        await this.database.triggerCode.transaction(organizationId, async () => {});
        const revision = await this.database.findOrganizationTriggerRevision(
          trigger.id,
          trigger.activeRevisionId,
        );
        return {
          triggerId: trigger.id,
          name: trigger.name,
          revisionId: trigger.activeRevisionId,
          version: revision!.version,
          digest: artifact.digest,
        };
      },
    );
  }

  async artifact(
    organizationId: string,
    triggerId: string,
    revisionId: string,
  ): Promise<TriggerArtifact> {
    const revision = await this.database.findOrganizationTriggerRevision(triggerId, revisionId);
    if (revision?.organizationId !== organizationId)
      throw new TriggerCodeError("Trigger revision not found", 404);
    const evidence = object(revision.sourceEvidence);
    if (evidence["artifact"] === undefined)
      throw new TriggerCodeError(
        "This historical Trigger revision is YAML; rewrite it as a code project before running it",
      );
    return validateArtifact(evidence["artifact"]);
  }

  async list(organizationId: string) {
    return Promise.all(
      (await this.database.listOrganizationTriggers(organizationId)).map(async (trigger) => {
        const revision = await this.database.findOrganizationTriggerRevision(
          trigger.id,
          trigger.activeRevisionId,
        );
        return {
          id: trigger.id,
          name: trigger.name,
          enabled: trigger.enabled,
          format: trigger.format,
          revisionId: trigger.activeRevisionId,
          version: revision?.version ?? 0,
          ...(trigger.format === "code"
            ? {
                ...(await this.metadata(organizationId, trigger.id, trigger.activeRevisionId)),
              }
            : {}),
        };
      }),
    );
  }

  private async metadata(organizationId: string, triggerId: string, revisionId: string) {
    const artifact = await this.artifact(organizationId, triggerId, revisionId);
    return { manifest: artifact.manifest, digest: artifact.digest };
  }

  async setEnabled(organizationId: string, triggerId: string, enabled: boolean) {
    const trigger = await this.trigger(organizationId, triggerId);
    const artifact = await this.artifact(organizationId, trigger.id, trigger.activeRevisionId);
    const routes = enabled ? (await this.validate(organizationId, artifact)).routes : [];
    const revision = await this.database.findOrganizationTriggerRevision(
      trigger.id,
      trigger.activeRevisionId,
    );
    await this.database.saveOrganizationTrigger({
      organizationId,
      triggerId,
      name: trigger.name,
      enabled,
      format: "code",
      yaml: revision!.yaml,
      normalizedConfiguration: revision!.normalizedConfiguration,
      contentHash: artifact.digest,
      sourceKind: "manual",
      sourceEvidence: revision!.sourceEvidence,
      createdByUserId: null,
      routes: enabled ? routes : [],
    });
  }

  async receive(
    organizationId: string,
    triggerId: string,
    event: TriggerEvent,
    revisionId?: string,
  ) {
    // Event envelopes never carry credentials; arbitrary payloads remain JSON, separate from prompts.
    bounded(event);
    const trigger = await this.trigger(organizationId, triggerId);
    if (!trigger.enabled) throw new TriggerCodeError("Trigger is disabled", 409);
    const revision = revisionId ?? trigger.activeRevisionId;
    const artifact = await this.artifact(organizationId, trigger.id, revision);
    if (!subscribes(artifact.manifest, event))
      throw new TriggerCodeError("Event does not match a declared Trigger subscription");
    return this.database.triggerCode.transaction(organizationId, (tx) =>
      this.enqueue(tx, organizationId, trigger.id, revision, artifact, event),
    );
  }

  private async enqueue(
    tx: TriggerCodeTransaction,
    organizationId: string,
    triggerId: string,
    revisionId: string,
    artifact: TriggerArtifact,
    event: TriggerEvent,
  ) {
    const created = await tx.appendEvent(triggerId, event);
    if (!created) return { created: false, run: await tx.runForEvent(triggerId, event) };
    const now = this.now();
    const run: CodeRun = {
      id: randomUUID(),
      organizationId,
      triggerId,
      revisionId,
      runner: artifact.manifest.runner,
      event,
      status: "queued",
      output: null,
      error: null,
      createdAt: now.toISOString(),
      deadlineAt: new Date(
        now.getTime() + parseDurationMs(artifact.manifest.limits.maxRuntime, "limits.maxRuntime"),
      ).toISOString(),
      completedAt: null,
      leaseHash: null,
      leaseExpiresAt: null,
      leaseRunnerId: null,
      wakeAt: null,
      waitingFor: [],
      cleanupPending: false,
    };
    await tx.putRun(run);
    return { created: true, run };
  }

  async publishEvent(organizationId: string, triggerId: string, event: TriggerEvent) {
    bounded(event);
    const trigger = await this.trigger(organizationId, triggerId);
    const artifact = await this.artifact(organizationId, trigger.id, trigger.activeRevisionId);
    if (trigger.enabled && subscribes(artifact.manifest, event))
      return this.receive(organizationId, trigger.id, event);
    if (await this.appendActiveEvent(organizationId, trigger.id, event))
      return { created: false, run: undefined };
    if (!trigger.enabled) throw new TriggerCodeError("Trigger is disabled", 409);
    throw new TriggerCodeError("Event does not match a declared Trigger subscription");
  }

  private async appendActiveEvent(organizationId: string, triggerId: string, event: TriggerEvent) {
    const revisions = await this.database.triggerCode.transaction(organizationId, (tx) =>
      tx.activeRevisions(triggerId),
    );
    for (const revisionId of revisions) {
      const artifact = await this.artifact(organizationId, triggerId, revisionId);
      if (!subscribes(artifact.manifest, event)) continue;
      await this.database.triggerCode.transaction(organizationId, async (tx) => {
        await tx.appendEvent(triggerId, event);
      });
      return true;
    }
    return false;
  }

  async acceptProviderEvent(event: DurableProviderEvent): Promise<boolean> {
    const trigger = (await this.database.listOrganizationTriggers(event.organizationId)).find(
      (item) => item.runtimeProjectId === event.projectId && item.format === "code",
    );
    if (trigger === undefined) return false;
    const usage = await this.database.organizationConnectionUsage(event.organizationId);
    const [source, ...parts] = event.source.split(".");
    const payload = object(event.payload);
    const raw = object(payload["payload"] ?? event.payload);
    const action = typeof raw["action"] === "string" ? raw["action"] : undefined;
    const type = parts.join(".");
    const provider = source ?? "";
    const connection = connectionProvider(provider)
      ? usage[provider].find((item) => item.id === event.connectionId)?.slug
      : undefined;
    const resource =
      typeof payload["repo"] === "string" ? payload["repo"] : (event.resourceId ?? undefined);
    const envelope: TriggerEvent = {
      id: event.deliveryId,
      source: source!,
      type: action === undefined ? type : `${type}.${action}`,
      receivedAt: event.receivedAt.toISOString(),
      payload: jsonValue(raw),
      ...(connection === undefined ? {} : { connection }),
      ...(resource === undefined ? {} : { resource }),
    };
    const runtimeRevision = await this.database.findProjectConfigurationRevision(
      event.projectId,
      event.configurationRevisionId,
    );
    const pinnedRevision = object(runtimeRevision?.sourceEvidence)["triggerRevisionId"];
    const revisionId =
      typeof pinnedRevision === "string" ? pinnedRevision : trigger.activeRevisionId;
    const artifact = await this.artifact(event.organizationId, trigger.id, revisionId);
    if (trigger.enabled && subscribes(artifact.manifest, envelope))
      await this.receive(event.organizationId, trigger.id, envelope, revisionId);
    else await this.appendActiveEvent(event.organizationId, trigger.id, envelope);
    return true;
  }

  async enroll(organizationId: string, name: string) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(name)) throw new TriggerCodeError("Invalid runner name");
    const token = `paseo_tr_${randomBytes(32).toString("base64url")}`;
    const runner: CodeRunner = {
      id: randomUUID(),
      organizationId,
      name,
      tokenHash: digest(token),
      revoked: false,
    };
    await this.database.triggerCode.transaction(organizationId, (tx) => tx.putRunner(runner));
    return { id: runner.id, name, token };
  }

  async runner(token: string): Promise<CodeRunner> {
    const runner = await this.database.triggerCode.runnerByHash(digest(token));
    if (runner === undefined || runner.revoked)
      throw new TriggerCodeError("Runner credential is invalid or revoked", 401);
    return runner;
  }

  async lease(runner: CodeRunner): Promise<TriggerJob | null> {
    await this.tickOrganization(runner.organizationId);
    const token = randomBytes(32).toString("base64url");
    const run = await this.database.triggerCode.transaction(runner.organizationId, async (tx) => {
      const candidate = await tx.nextQueuedRun(runner.name);
      if (candidate === undefined) return null;
      candidate.status = "running";
      candidate.leaseHash = digest(token);
      candidate.leaseRunnerId = runner.id;
      candidate.leaseExpiresAt = new Date(this.now().getTime() + LEASE_MS).toISOString();
      await tx.putRun(candidate);
      return candidate;
    });
    if (run === null) return null;
    return {
      run,
      leaseToken: token,
      artifact: await this.artifact(runner.organizationId, run.triggerId, run.revisionId),
    };
  }

  private async leased(tx: TriggerCodeTransaction, runId: string, token: string): Promise<CodeRun> {
    const run = await tx.getRun(runId);
    if (run === undefined) throw new TriggerCodeError("Trigger run not found", 404);
    if (
      terminal(run) ||
      run.leaseHash !== digest(token) ||
      run.leaseExpiresAt === null ||
      run.leaseExpiresAt <= this.now().toISOString()
    )
      throw new TriggerCodeError("Trigger run lease is stale", 409);
    if (run.deadlineAt <= this.now().toISOString())
      throw new TriggerCodeError("Trigger run deadline exceeded", 409);
    return run;
  }

  async heartbeat(organizationId: string, runId: string, token: string) {
    await this.database.triggerCode.transaction(organizationId, async (tx) => {
      const run = await this.leased(tx, runId, token);
      run.leaseExpiresAt = new Date(
        Math.min(Date.parse(run.deadlineAt), this.now().getTime() + LEASE_MS),
      ).toISOString();
      await tx.putRun(run);
    });
  }

  async operation(
    organizationId: string,
    runId: string,
    token: string,
    request: OperationRequest,
  ): Promise<OperationReply> {
    if (
      typeof request.id !== "string" ||
      request.id.length < 1 ||
      request.id.length > 500 ||
      typeof request.kind !== "string"
    )
      throw new TriggerCodeError("Operation requires a stable id and kind");
    bounded(request.input);
    const current = await this.database.triggerCode.transaction(organizationId, (tx) =>
      tx.getRun(runId),
    );
    if (current === undefined) throw new TriggerCodeError("Trigger run not found", 404);
    const artifact = await this.artifact(organizationId, current.triggerId, current.revisionId);
    const outcome = await this.database.triggerCode.transaction(organizationId, async (tx) => {
      const run = await this.leased(tx, runId, token);
      const hash = digest(request.input);
      const existing = await tx.getOperation(runId, request.id);
      if (existing !== undefined) {
        if (existing.kind !== request.kind || existing.inputHash !== hash)
          throw new TriggerCodeError(
            `Nondeterministic replay: operation ${request.id} changed kind or input`,
            409,
          );
        if (existing.status === "completed")
          return { reply: { status: "completed" as const, output: existing.output } };
        if (existing.status === "failed")
          return {
            reply: {
              status: "failed" as const,
              error: existing.error!,
              ...(existing.failure === undefined ? {} : { failure: existing.failure }),
            },
          };
        if (["step", "github"].includes(existing.kind) && existing.leaseHash !== run.leaseHash) {
          existing.status = "failed";
          existing.error =
            "Step interrupted with an unknown external outcome; reconcile before explicitly retrying";
          existing.failure = {
            code: "OPERATION_INTERRUPTED",
            outcome: "unknown",
            retryable: existing.kind === "github" && object(existing.input)["method"] === "GET",
          };
          await tx.putOperation(existing);
          return {
            reply: { status: "failed" as const, error: existing.error, failure: existing.failure },
          };
        }
        return { reply: { status: "waiting" as const } };
      }
      const now = this.now();
      const op: CodeOperation = {
        runId,
        id: request.id,
        kind: request.kind,
        input: request.input,
        inputHash: hash,
        status: "running",
        output: null,
        error: null,
        wakeAt: null,
        childRunId: null,
        leaseHash: run.leaseHash!,
        createdAt: now.toISOString(),
      };
      await this.applyOperation(tx, run, op, artifact);
      await tx.putOperation(op);
      return {
        reply:
          op.status === "completed"
            ? { status: "completed" as const, output: op.output }
            : { status: op.kind === "step" ? ("execute" as const) : ("waiting" as const) },
        operation: op,
        run,
      };
    });
    if (outcome.run !== undefined && outcome.operation?.kind === "agent")
      await this.ensureAgent(outcome.run, outcome.operation, artifact);
    if (outcome.run !== undefined && outcome.operation?.kind === "github") {
      try {
        const output = await this.host.github(outcome.run, artifact, request.input);
        await this.completeOperation(organizationId, runId, token, request.id, { output });
        return { status: "completed", output };
      } catch (error) {
        const message = errorMessage(error);
        const failure = errorFailure(error);
        const result = { error: message, ...(failure === undefined ? {} : { failure }) };
        await this.completeOperation(organizationId, runId, token, request.id, result);
        return { status: "failed", ...result };
      }
    }
    return outcome.reply;
  }

  private async applyOperation(
    tx: TriggerCodeTransaction,
    run: CodeRun,
    op: CodeOperation,
    artifact: TriggerArtifact,
  ) {
    if (["claim", "lock", "unlock", "state.get", "state.set", "state.delete"].includes(op.kind))
      return this.stateOperation(tx, run, op);
    const value = object(op.input);
    switch (op.kind) {
      case "step":
        return;
      case "agent":
        return this.agentOperation(tx, run, op, artifact);
      case "sleep": {
        const milliseconds = Number(value["milliseconds"]);
        if (!Number.isFinite(milliseconds) || milliseconds < 0)
          throw new TriggerCodeError("Sleep duration must be finite and non-negative");
        op.wakeAt = new Date(this.now().getTime() + milliseconds).toISOString();
        op.status = "waiting";
        if (milliseconds === 0) complete(op, null);
        return;
      }
      case "event":
        return this.eventOperation(tx, run, op, artifact);
      case "github":
        return this.githubOperation(op, artifact);
      default:
        throw new TriggerCodeError(`Unsupported Trigger operation: ${op.kind}`);
    }
  }

  private async agentOperation(
    tx: TriggerCodeTransaction,
    run: CodeRun,
    op: CodeOperation,
    artifact: TriggerArtifact,
  ) {
    const options = CodeAgentOptionsSchema.parse(op.input);
    if (
      artifact.manifest.limits.maxAgentRuns !== undefined &&
      (await tx.operations(run.id)).filter((item) => item.kind === "agent").length >=
        artifact.manifest.limits.maxAgentRuns
    )
      throw new TriggerCodeError("Trigger agent run limit exceeded");
    const target = ownGrant(artifact.manifest.grants.targets, options.target);
    if (target === undefined || !target.providers.includes(options.agent?.provider))
      throw new TriggerCodeError("Agent target or provider is not granted", 403);
    if (
      options.github !== undefined &&
      ownGrant(artifact.manifest.grants.github, options.github) === undefined
    )
      throw new TriggerCodeError("GitHub authority is not granted", 403);
    if (
      options.env !== undefined &&
      Object.keys(options.env).some(
        (key) => !Object.hasOwn(target.env ?? {}, key) || target.env?.[key] !== options.env?.[key],
      )
    )
      throw new TriggerCodeError("Agent environment must be declared in the target grant", 403);
    op.childRunId = randomUUID();
    op.status = "waiting";
  }

  private async eventOperation(
    tx: TriggerCodeTransaction,
    run: CodeRun,
    op: CodeOperation,
    artifact: TriggerArtifact,
  ) {
    const value = object(op.input);
    if (
      typeof value["source"] !== "string" ||
      (typeof value["event"] !== "string" && !Array.isArray(value["event"])) ||
      typeof value["timeout"] !== "string"
    )
      throw new TriggerCodeError("Event wait requires source, event and timeout");
    if (!artifact.manifest.on.some((item) => item.source === value["source"]))
      throw new TriggerCodeError("Event wait source is not subscribed", 403);
    const first = await tx.getOperation(run.id, `${String(value["group"])}:0`);
    op.wakeAt =
      first?.wakeAt ??
      new Date(
        this.now().getTime() + parseDurationMs(value["timeout"], "event.timeout"),
      ).toISOString();
    op.status = "waiting";
  }

  private githubOperation(op: CodeOperation, artifact: TriggerArtifact) {
    const value = object(op.input);
    const grant =
      typeof value["grant"] === "string"
        ? ownGrant(artifact.manifest.grants.github, value["grant"])
        : undefined;
    if (grant === undefined) throw new TriggerCodeError("GitHub connection is not granted", 403);
    const path = typeof value["path"] === "string" ? value["path"] : "";
    const url = new URL(path, "https://api.github.com");
    if (
      !path.startsWith("/repos/") ||
      url.origin !== "https://api.github.com" ||
      !grant.repositories.some(
        (repo) => url.pathname.startsWith(`/repos/${repo}/`) || url.pathname === `/repos/${repo}`,
      ) ||
      /%2f|%5c|\\/iu.test(path)
    )
      throw new TriggerCodeError("GitHub request is outside the granted repositories", 403);
  }

  private async stateOperation(tx: TriggerCodeTransaction, run: CodeRun, op: CodeOperation) {
    const value = object(op.input),
      key = stateKey(value);
    switch (op.kind) {
      case "claim": {
        const prior = await tx.getState(run.triggerId, "claim", key);
        if (prior === undefined)
          await tx.putState(run.triggerId, { kind: "claim", key, value: true, ownerRunId: run.id });
        complete(op, prior === undefined || prior.ownerRunId === run.id);
        return;
      }
      case "lock": {
        const prior = await tx.getState(run.triggerId, "lock", key);
        if (prior === undefined || prior.ownerRunId === run.id) {
          await tx.putState(run.triggerId, { kind: "lock", key, value: null, ownerRunId: run.id });
          complete(op, null);
        } else op.status = "waiting";
        return;
      }
      case "unlock": {
        const prior = await tx.getState(run.triggerId, "lock", key);
        if (prior?.ownerRunId === run.id) await tx.deleteState(run.triggerId, "lock", key);
        complete(op, null);
        return;
      }
      case "state.get":
        complete(op, (await tx.getState(run.triggerId, "state", key))?.value ?? null);
        return;
      case "state.set":
        await tx.putState(run.triggerId, {
          kind: "state",
          key,
          value: value["value"],
          ownerRunId: null,
        });
        complete(op, null);
        return;
      case "state.delete":
        await tx.deleteState(run.triggerId, "state", key);
        complete(op, null);
        return;
    }
  }

  async completeOperation(
    organizationId: string,
    runId: string,
    token: string,
    operationId: string,
    result: { output: unknown } | { error: string; failure?: TriggerFailure },
  ) {
    bounded(result);
    await this.database.triggerCode.transaction(organizationId, async (tx) => {
      const run = await this.leased(tx, runId, token);
      const op = await tx.getOperation(runId, operationId);
      if (
        op === undefined ||
        !["step", "github"].includes(op.kind) ||
        op.leaseHash !== run.leaseHash
      )
        throw new TriggerCodeError("Operation completion is not authorized", 409);
      if (op.status === "completed" || op.status === "failed") return;
      op.status = "error" in result ? "failed" : "completed";
      op.error = "error" in result ? result.error : null;
      if ("error" in result && result.failure !== undefined) op.failure = result.failure;
      op.output = "output" in result ? result.output : null;
      await tx.putOperation(op);
    });
  }

  async report(
    organizationId: string,
    runId: string,
    token: string,
    result: {
      status: "suspended" | "succeeded" | "failed" | "skipped";
      output?: unknown;
      error?: string | undefined;
      waitingFor?: string[] | undefined;
    },
  ) {
    bounded(result);
    await this.database.triggerCode.transaction(organizationId, async (tx) => {
      const run = await this.leased(tx, runId, token);
      if (result.status === "suspended") {
        if (!Array.isArray(result.waitingFor) || result.waitingFor.length === 0)
          throw new TriggerCodeError("Suspended run must name its waiting operations");
        for (const id of result.waitingFor)
          if (typeof id !== "string" || (await tx.getOperation(runId, id)) === undefined)
            throw new TriggerCodeError("Unknown waiting operation");
        run.waitingFor = result.waitingFor;
        run.status = "waiting";
        run.leaseExpiresAt = null;
      } else {
        if (
          result.status === "succeeded" &&
          (await tx.operations(runId)).some(
            (op) => op.status === "running" || op.status === "waiting",
          )
        )
          throw new TriggerCodeError(
            "Trigger returned with unfinished operations; await every child operation",
            409,
          );
        run.status = result.status;
        run.output = result.output ?? null;
        run.error = result.error ?? null;
        run.completedAt = this.now().toISOString();
        run.leaseExpiresAt = null;
        run.cleanupPending = result.status !== "succeeded";
        await tx.releaseLocks(runId);
      }
      await tx.putRun(run);
    });
    await this.tickOrganization(organizationId);
  }

  async log(
    organizationId: string,
    runId: string,
    token: string,
    message: string,
    data: unknown = null,
  ) {
    if (typeof message !== "string" || message.length > 16_000)
      throw new TriggerCodeError("Invalid Trigger log message");
    bounded(data);
    await this.database.triggerCode.transaction(organizationId, async (tx) => {
      await this.leased(tx, runId, token);
      await tx.log({ id: randomUUID(), runId, time: this.now().toISOString(), message, data });
    });
  }

  async cancel(organizationId: string, runId: string) {
    const children = await this.database.triggerCode.transaction(organizationId, async (tx) => {
      const run = await tx.getRun(runId);
      if (run === undefined) throw new TriggerCodeError("Trigger run not found", 404);
      if (terminal(run)) return [];
      await this.finish(tx, run, "cancelled", "Cancelled by operator");
      return (await tx.operations(runId)).flatMap((op) =>
        op.childRunId === null ? [] : [op.childRunId],
      );
    });
    await Promise.all(children.map((id) => this.host.cancel(id, "Parent Trigger cancelled")));
  }

  start() {
    this.timer ??= setInterval(() => {
      if (this.processing !== undefined) return;
      this.processing = this.tick()
        .catch((error) => {
          reportFailure(error, { component: "triggers", operation: "code.tick" });
        })
        .finally(() => {
          this.processing = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.processing;
  }
  async tick() {
    for (const organizationId of await this.database.triggerCode.organizations())
      await this.tickOrganization(organizationId);
  }

  async tickOrganization(organizationId: string) {
    const runs: CodeRun[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.database.triggerCode.transaction(organizationId, (tx) =>
        tx.activeRuns(after),
      );
      runs.push(...page);
      if (page.length < 100) break;
      after = page[page.length - 1]!.id;
    }
    for (const run of runs) {
      if (terminal(run)) {
        await this.cleanup(run);
        continue;
      }
      const operations = await this.database.triggerCode.transaction(organizationId, (tx) =>
        tx.operations(run.id),
      );
      const artifact = await this.artifact(organizationId, run.triggerId, run.revisionId);
      for (const op of operations.filter(
        (item) => item.kind === "agent" && item.status === "waiting",
      )) {
        await this.ensureAgent(run, op, artifact);
        const child =
          op.childRunId === null
            ? undefined
            : await this.database.findTriggerRunById(op.childRunId);
        if (child !== undefined && child.status !== "running") {
          const steps = await this.database.listWorkflowStepRunsForTriggerRun(child.id);
          await this.database.triggerCode.transaction(organizationId, async (tx) => {
            const current = await tx.getOperation(run.id, op.id);
            if (current?.status !== "waiting") return;
            current.status = child.status === "succeeded" ? "completed" : "failed";
            current.output = {
              runId: child.id,
              executionId: steps[0]?.agentExecutionId ?? null,
              output: steps[0]?.output ?? null,
            };
            current.error =
              child.outcome === "accepted" ? child.failureReason : "Agent invocation rejected";
            await tx.putOperation(current);
          });
        }
      }
      const timedOutChildren = await this.database.triggerCode.transaction(
        organizationId,
        async (tx) => {
          const current = await tx.getRun(run.id);
          if (current === undefined || terminal(current)) return [];
          const now = this.now().toISOString();
          if (current.deadlineAt <= now) {
            await this.finish(tx, current, "timed_out", "Trigger run deadline exceeded");
            return (await tx.operations(run.id)).flatMap((op) =>
              op.childRunId === null ? [] : [op.childRunId],
            );
          }
          if (
            current.status === "running" &&
            current.leaseExpiresAt !== null &&
            current.leaseExpiresAt <= now
          ) {
            current.status = "queued";
            current.leaseExpiresAt = null;
          }
          const pending = await tx.operations(run.id);
          for (const op of pending.filter((item) => item.status === "waiting"))
            await this.resolveWait(tx, current, op, now, artifact);
          if (current.status === "waiting") {
            const resolved = await tx.operations(run.id);
            // Replaying a running local step is unsafe after a lost worker; operation() records it.
            if (
              resolved.some(
                (op) =>
                  current.waitingFor.includes(op.id) &&
                  (op.status === "completed" || op.status === "failed"),
              )
            )
              current.status = "queued";
          }
          await tx.putRun(current);
          return [];
        },
      );
      await Promise.all(
        timedOutChildren.map((id) => this.host.cancel(id, "Parent Trigger timed out")),
      );
    }
    await this.schedule(organizationId);
  }

  private async resolveWait(
    tx: TriggerCodeTransaction,
    run: CodeRun,
    op: CodeOperation,
    now: string,
    artifact: TriggerArtifact,
  ) {
    const value = object(op.input);
    if (op.kind === "sleep" && op.wakeAt !== null && op.wakeAt <= now) {
      op.status = "completed";
      op.output = null;
    }
    if (op.kind === "event") {
      let cursor = Number(value["cursor"] ?? 0);
      for (;;) {
        const events = await tx.events(run.triggerId, cursor, run.createdAt);
        const event = events.find(
          (item) =>
            item.event.source === value["source"] &&
            subscribes(artifact.manifest, item.event) &&
            matchesPattern(item.event.type, eventPattern(value["event"])),
        );
        if (event !== undefined) {
          op.status = "completed";
          op.output = { cursor: event.sequence, event: event.event };
          break;
        }
        if (events.length < 500) break;
        cursor = events[events.length - 1]!.sequence;
      }
      if (op.status === "waiting" && op.wakeAt !== null && op.wakeAt <= now) {
        op.status = "failed";
        op.error = "Timed out waiting for Trigger event";
      }
    }
    if (op.kind === "lock") {
      const key = stateKey(value),
        prior = await tx.getState(run.triggerId, "lock", key);
      if (prior === undefined || prior.ownerRunId === run.id) {
        await tx.putState(run.triggerId, { kind: "lock", key, value: null, ownerRunId: run.id });
        op.status = "completed";
        op.output = null;
      }
    }
    await tx.putOperation(op);
  }

  private async ensureAgent(run: CodeRun, operation: CodeOperation, artifact: TriggerArtifact) {
    if (run.deadlineAt <= this.now().toISOString()) return;
    try {
      await this.host.ensure(run, operation, artifact);
    } catch (error) {
      if (error instanceof Error && error.name === "TriggerAgentUnavailableError") return;
      await this.database.triggerCode.transaction(run.organizationId, async (tx) => {
        const op = await tx.getOperation(run.id, operation.id);
        if (op?.status !== "waiting") return;
        op.status = "failed";
        op.error = errorMessage(error);
        await tx.putOperation(op);
      });
    }
  }

  private async finish(
    tx: TriggerCodeTransaction,
    run: CodeRun,
    status: CodeRunStatus,
    error: string,
  ) {
    run.status = status;
    run.error = error;
    run.completedAt = this.now().toISOString();
    run.leaseExpiresAt = null;
    run.cleanupPending = true;
    await tx.putRun(run);
    await tx.releaseLocks(run.id);
  }

  private async cleanup(run: CodeRun) {
    const operations = await this.database.triggerCode.transaction(run.organizationId, (tx) =>
      tx.operations(run.id),
    );
    await Promise.all(
      operations.flatMap((op) =>
        op.childRunId === null
          ? []
          : [this.host.cancel(op.childRunId, `Parent Trigger ${run.status}`)],
      ),
    );
    await this.database.triggerCode.transaction(run.organizationId, async (tx) => {
      const current = await tx.getRun(run.id);
      if (current !== undefined && terminal(current)) {
        current.cleanupPending = false;
        await tx.putRun(current);
      }
    });
  }

  private async schedule(organizationId: string) {
    for (const trigger of (await this.database.listOrganizationTriggers(organizationId)).filter(
      (item) => item.format === "code" && item.enabled,
    )) {
      const artifact = await this.artifact(organizationId, trigger.id, trigger.activeRevisionId);
      const recurrence = artifact.manifest.on.find(
        (item) => item.source === "schedule",
      )?.recurrence;
      if (recurrence === undefined) continue;
      await this.database.triggerCode.transaction(organizationId, async (tx) => {
        const previous = await tx.getState(trigger.id, "state", "__schedule");
        const value = object(previous?.value);
        const now = this.now();
        const recurrenceHash = digest(recurrence);
        if (value["hash"] === recurrenceHash && value["next"] === null) return;
        const next =
          value["hash"] === recurrenceHash && typeof value["next"] === "string"
            ? value["next"]
            : nextOccurrence(recurrence, new Date(trigger.createdAt))?.toISOString();
        if (next === undefined) return;
        if (next > now.toISOString()) {
          await tx.putState(trigger.id, {
            key: "__schedule",
            kind: "state",
            ownerRunId: null,
            value: { hash: recurrenceHash, next },
          });
          return;
        }
        await tx.putState(trigger.id, {
          key: "__schedule",
          kind: "state",
          ownerRunId: null,
          value: {
            hash: recurrenceHash,
            next: nextOccurrence(recurrence, now)?.toISOString() ?? null,
          },
        });
        // The occurrence and cursor commit together. A Hub crash cannot lose a
        // tick between advancing the cursor and durably enqueuing the run.
        await this.enqueue(tx, organizationId, trigger.id, trigger.activeRevisionId, artifact, {
          id: `schedule:${next}`,
          source: "schedule",
          type: "tick",
          receivedAt: next,
          payload: { scheduledAt: next, timezone: recurrence.timezone },
        });
      });
    }
  }

  async trigger(organizationId: string, idOrName: string): Promise<OrganizationTriggerRecord> {
    const trigger = (await this.database.listOrganizationTriggers(organizationId)).find(
      (item) => item.id === idOrName || item.name === idOrName,
    );
    if (trigger === undefined) throw new TriggerCodeError("Trigger not found", 404);
    return trigger;
  }
}

function bounded(value: unknown) {
  if (Buffer.byteLength(stableJson(value)) > MAX_VALUE_BYTES)
    throw new TriggerCodeError("Trigger operation data exceeds 1 MiB");
}
function stateKey(value: Record<string, unknown>) {
  const key = value["key"];
  if (typeof key !== "string" || key.length < 1 || key.length > 500 || key.startsWith("__"))
    throw new TriggerCodeError("State key must contain 1–500 characters and cannot start with __");
  return key;
}
export function object(value: unknown): Record<string, unknown> {
  return recordValue(value) ? value : {};
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function complete(operation: CodeOperation, output: unknown) {
  operation.status = "completed";
  operation.output = output;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function connectionProvider(value: string): value is "github" | "slack" | "discord" | "linear" {
  return ["github", "slack", "discord", "linear"].includes(value);
}

function eventPattern(value: unknown): string | string[] {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new TriggerCodeError("Invalid event pattern");
}
