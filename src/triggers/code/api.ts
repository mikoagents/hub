import { jsonValue } from "./contract.js";
/* oxlint-disable complexity, max-depth -- Canonical HTTP route branches share one bounded-body and authorization boundary. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PublicApi, PublicApiComposition } from "../../public-api/index.js";
import type { ApiKeyScope } from "../../auth/api-key-contract.js";
import { isDatabaseUnavailableError } from "../../db/errors.js";
import { reportFailure } from "../../failures/index.js";
import { TriggerCodeError, object, type TriggerCodeService } from "./service.js";
import type { TriggerEvent } from "./sdk.js";
import type { CodeRun } from "./records.js";
import { triggerCodeOpenApiDocument, triggerRouteMethod } from "./openapi.js";
import { publicOperation } from "../../public-api/operation-manifest.js";

const eventSchema = z
  .object({
    id: z.string().min(1).max(500),
    source: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    type: z.string().min(1).max(200),
    payload: z.unknown(),
    connection: z.string().min(1).max(200).optional(),
    resource: z.string().min(1).max(500).optional(),
  })
  .strict();

export function createTriggerCodeApi(
  service: TriggerCodeService,
  composition: PublicApiComposition,
  fallback: PublicApi,
): PublicApi {
  return {
    ...fallback,
    handleOperation: (id, request) => {
      const definition = publicOperation(id);
      if (!definition.path.startsWith("/api/v1/triggers"))
        return fallback.handleOperation(id, request);
      const url = new URL(request.url);
      url.pathname = definition.path;
      return handle(service, composition, new Request(url, request));
    },
    openapi: () =>
      Response.json(triggerCodeOpenApiDocument, {
        headers: { "cache-control": "public, max-age=300" },
      }),
    handle: (request) =>
      new URL(request.url).pathname.startsWith("/api/v1/triggers")
        ? handle(service, composition, request)
        : fallback.handle(request),
  };
}

async function handle(
  service: TriggerCodeService,
  composition: PublicApiComposition,
  request: Request,
): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  try {
    const url = new URL(request.url);
    const path = url.pathname
      .slice("/api/v1/triggers".length)
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const method = triggerRouteMethod(path);
    if (method === undefined) return problem(requestId, 404, "not_found", "Unknown Trigger route");
    if (request.method !== method)
      return problem(requestId, 405, "method_not_allowed", `Use ${method}`, { allow: method });
    const reply = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { "x-request-id": requestId } });
    const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/iu)?.[1] ?? "";
    if (path[0] === "runner") {
      if (request.method !== "POST")
        return problem(requestId, 405, "method_not_allowed", "Use POST", { allow: "POST" });
      if (path[1] === "lease" && path.length === 2)
        return reply({ job: await service.lease(await service.runner(bearer)) });
      if (path[1] === "runs" && path.length === 5) {
        const organizationId = path[2]!,
          runId = path[3]!,
          action = path[4]!;
        const body = object(await readJson(request));
        switch (action) {
          case "heartbeat":
            await service.heartbeat(organizationId, runId, bearer);
            break;
          case "operation":
            return reply(
              await service.operation(organizationId, runId, bearer, {
                id: z.string().min(1).parse(body["id"]),
                kind: z.string().min(1).parse(body["kind"]),
                input: body["input"] ?? null,
              }),
            );
          case "complete-operation": {
            if (typeof body["id"] !== "string") throw new TriggerCodeError("Operation id required");
            const result = Object.hasOwn(body, "error")
              ? { error: z.string().parse(body["error"]) }
              : { output: body["output"] ?? null };
            await service.completeOperation(organizationId, runId, bearer, body["id"], result);
            break;
          }
          case "report": {
            const result = z
              .object({
                status: z.enum(["suspended", "succeeded", "failed", "skipped"]),
                output: z.unknown().optional(),
                error: z.string().optional(),
                waitingFor: z.array(z.string()).optional(),
              })
              .strict()
              .parse(body);
            await service.report(organizationId, runId, bearer, result);
            break;
          }
          case "log":
            await service.log(
              organizationId,
              runId,
              bearer,
              z.string().parse(body["message"]),
              body["data"] ?? null,
            );
            break;
          default:
            return problem(requestId, 404, "not_found", "Unknown runner operation");
        }
        return reply({ ok: true });
      }
      return problem(requestId, 404, "not_found", "Unknown runner route");
    }
    if (composition.status !== "enabled")
      return problem(
        requestId,
        503,
        "infrastructure_unavailable",
        "Trigger authentication is unavailable",
      );
    let scope: ApiKeyScope = "configuration:validate";
    if (request.method !== "GET")
      scope = ["run", "events", "cancel"].includes(path[path.length - 1] ?? "")
        ? "runs:dispatch"
        : "configuration:install";
    if (path[0] === "validate") scope = "configuration:validate";
    const authorization = await composition.authenticator.authorize(request, scope);
    if (authorization.status !== "authorized")
      return problem(
        requestId,
        authorization.status === "unauthorized" ? 401 : 403,
        authorization.status,
        `An active organization credential with ${scope} is required`,
      );
    const organizationId = authorization.access.organizationId;
    if (path.length === 0 && request.method === "GET")
      return reply({ triggers: await service.list(organizationId) });
    if (
      path.length === 1 &&
      ["validate", "install"].includes(path[0]!) &&
      request.method === "POST"
    ) {
      const body = await readJson(request);
      const artifact = object(body)["artifact"] ?? body;
      if (path[0] === "validate") {
        const prepared = await service.validate(organizationId, artifact);
        return reply({
          valid: true,
          name: prepared.artifact.manifest.name,
          digest: prepared.artifact.digest,
        });
      }
      return reply(
        {
          ...(await service.deploy(organizationId, artifact, {
            credentialId: authorization.access.credentialId,
            credentialKind: authorization.access.kind,
          })),
          active: true,
        },
        201,
      );
    }
    if (path[0] === "runners" && path.length === 1 && request.method === "POST")
      return reply(
        await service.enroll(
          organizationId,
          z.string().parse(object(await readJson(request))["name"]),
        ),
        201,
      );
    if (path[0] === "runs" && path[1] !== undefined) {
      const runId = z.string().uuid().parse(path[1]);
      if (path.length === 2 && request.method === "GET") {
        const detail = await service.database.triggerCode.transaction(
          organizationId,
          async (tx) => {
            const run = await tx.getRun(runId);
            if (run === undefined) throw new TriggerCodeError("Trigger run not found", 404);
            return {
              run: publicRun(run),
              operations: (await tx.operations(runId)).map(
                ({ leaseHash: _lease, ...operation }) => operation,
              ),
              logs: await tx.logs(runId),
            };
          },
        );
        return reply(detail);
      }
      if (path[2] === "cancel" && path.length === 3 && request.method === "POST") {
        await service.cancel(organizationId, runId);
        return reply({ ok: true });
      }
    }
    if (path[0] !== undefined) {
      const trigger = await service.trigger(organizationId, path[0]);
      if (path[1] === "revisions" && path.length === 2)
        return reply({
          revisions: await service.database.listOrganizationTriggerRevisions(
            organizationId,
            trigger.id,
          ),
        });
      if (path[1] === "revisions" && path.length === 3 && request.method === "GET")
        return reply({
          artifact: await service.artifact(
            organizationId,
            trigger.id,
            z.string().uuid().parse(path[2]),
          ),
        });
      if (path[1] === "runs" && path.length === 2 && request.method === "GET")
        return reply({
          runs: await service.database.triggerCode.transaction(organizationId, async (tx) =>
            (await tx.listRuns(trigger.id)).map(publicRun),
          ),
        });
      if (path[1] === "enabled" && path.length === 2 && request.method === "POST") {
        await service.setEnabled(
          organizationId,
          trigger.id,
          z.boolean().parse(object(await readJson(request))["enabled"]),
        );
        return reply({ ok: true });
      }
      if (
        (path[1] === "run" || path[1] === "events") &&
        path.length === 2 &&
        request.method === "POST"
      ) {
        const body = object(await readJson(request));
        let event: TriggerEvent;
        if (path[1] === "run")
          event = {
            id: typeof body["deliveryKey"] === "string" ? body["deliveryKey"] : randomUUID(),
            source: "manual",
            type: "run",
            receivedAt: new Date().toISOString(),
            payload: jsonValue(body["input"] ?? null),
          };
        else {
          const parsed = eventSchema.parse(body);
          if (
            ["github", "slack", "discord", "linear", "schedule", "manual"].includes(parsed.source)
          )
            throw new TriggerCodeError(
              "Native provider events must use their verified intake endpoint",
              403,
            );
          event = {
            ...parsed,
            payload: jsonValue(parsed.payload ?? null),
            receivedAt: new Date().toISOString(),
          };
        }
        const result =
          path[1] === "events"
            ? await service.publishEvent(organizationId, trigger.id, event)
            : await service.receive(organizationId, trigger.id, event);
        return reply(
          { created: result.created, run: result.run === undefined ? null : publicRun(result.run) },
          result.created ? 201 : 200,
        );
      }
    }
    return problem(requestId, 404, "not_found", "No Trigger route matches this method and path");
  } catch (error) {
    if (error instanceof URIError)
      return problem(
        requestId,
        400,
        "invalid_path",
        "Trigger path contains malformed URI encoding",
      );
    if (error instanceof TriggerCodeError)
      return problem(requestId, error.status, "trigger_error", error.message);
    if (error instanceof z.ZodError)
      return problem(
        requestId,
        422,
        "invalid_trigger",
        error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    if (error instanceof SyntaxError)
      return problem(requestId, 400, "invalid_json", "Request body must be valid JSON");
    reportFailure(error, { component: "triggers", operation: "code.api", requestId });
    return problem(
      requestId,
      isDatabaseUnavailableError(error) ? 503 : 500,
      "trigger_unavailable",
      "Trigger operation failed; use the request ID to inspect diagnostics",
    );
  }
}

export function publicRun(run: CodeRun) {
  const { leaseHash: _hash, leaseExpiresAt: _expires, leaseRunnerId: _runner, ...view } = run;
  return view;
}
function problem(
  requestId: string,
  status: number,
  code: string,
  detail: string,
  headers: Record<string, string> = {},
) {
  return Response.json(
    {
      type: `https://paseo.sh/problems/${code.replaceAll("_", "-")}`,
      title: code.replaceAll("_", " "),
      status,
      detail,
      code,
      requestId,
    },
    {
      status,
      headers: {
        "content-type": "application/problem+json",
        "x-request-id": requestId,
        ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
        ...headers,
      },
    },
  );
}
async function readJson(request: Request): Promise<unknown> {
  if (request.body === null) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 24 * 1024 * 1024) {
      await reader.cancel();
      throw new TriggerCodeError("Request exceeds 24 MiB", 413);
    }
    chunks.push(chunk.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
