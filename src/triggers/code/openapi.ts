import { z } from "zod";
import { publicOpenApiDocument } from "../../public-api/openapi.js";
import { TriggerArtifactSchema } from "./contract.js";

const bearer = [{ bearerAuth: [] }];
const json = (schema: unknown) => ({ "application/json": { schema } });
const problem = {
  description: "RFC 9457 problem response with an X-Request-ID header.",
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
};
const object = { type: "object", additionalProperties: true };
function operation(summary: string, scope: string, request?: unknown, status = "200") {
  return {
    summary,
    tags: ["Triggers"],
    security: bearer,
    "x-required-scope": scope,
    ...(request === undefined ? {} : { requestBody: { required: true, content: json(request) } }),
    responses: {
      [status]: { description: "Operation succeeded.", content: json(object) },
      "400": problem,
      "401": problem,
      "403": problem,
      "404": problem,
      "409": problem,
      "422": problem,
      "503": problem,
    },
  };
}
const triggerParameter = {
  name: "trigger",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Organization Trigger name or UUID.",
};
const runParameter = {
  name: "run",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
};
const artifact = z.toJSONSchema(TriggerArtifactSchema, { unrepresentable: "any" });
const deployment = {
  type: "object",
  properties: { artifact },
  required: ["artifact"],
  additionalProperties: false,
};

export const triggerCodeOpenApiDocument = {
  ...publicOpenApiDocument,
  paths: {
    ...publicOpenApiDocument.paths,
    "/api/v1/triggers": {
      get: operation(
        "List Trigger code deployments and historical configuration metadata",
        "configuration:validate",
      ),
    },
    "/api/v1/triggers/validate": {
      post: operation(
        "Validate a Trigger code artifact without executing its module",
        "configuration:validate",
        deployment,
      ),
    },
    "/api/v1/triggers/install": {
      post: operation(
        "Install an immutable code revision, preserving Trigger identity",
        "configuration:install",
        deployment,
        "201",
      ),
    },
    "/api/v1/triggers/runners": {
      post: operation(
        "Enroll or rotate a named Trigger runner credential",
        "configuration:install",
        {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        "201",
      ),
    },
    "/api/v1/triggers/{trigger}/run": {
      parameters: [triggerParameter],
      post: operation(
        "Dispatch the declared manual.run subscription",
        "runs:dispatch",
        {
          type: "object",
          properties: { deliveryKey: { type: "string" }, input: {} },
          additionalProperties: false,
        },
        "201",
      ),
    },
    "/api/v1/triggers/{trigger}/events": {
      parameters: [triggerParameter],
      post: operation(
        "Publish a custom event; native provider events use verified intake",
        "runs:dispatch",
        {
          type: "object",
          properties: {
            id: { type: "string" },
            source: { type: "string" },
            type: { type: "string" },
            payload: {},
          },
          required: ["id", "source", "type", "payload"],
          additionalProperties: false,
        },
        "201",
      ),
    },
    "/api/v1/triggers/{trigger}/enabled": {
      parameters: [triggerParameter],
      post: operation("Enable or disable a Trigger", "configuration:install", {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
        additionalProperties: false,
      }),
    },
    "/api/v1/triggers/{trigger}/runs": {
      parameters: [triggerParameter],
      get: operation("List recent Trigger runs", "configuration:validate"),
    },
    "/api/v1/triggers/{trigger}/revisions": {
      parameters: [triggerParameter],
      get: operation("List recent immutable revisions", "configuration:validate"),
    },
    "/api/v1/triggers/{trigger}/revisions/{revision}": {
      parameters: [
        triggerParameter,
        {
          name: "revision",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      get: operation("Read an immutable Trigger artifact", "configuration:validate"),
    },
    "/api/v1/triggers/runs/{run}": {
      parameters: [runParameter],
      get: operation(
        "Read a Trigger run, operation journal and recent runner log",
        "configuration:validate",
      ),
    },
    "/api/v1/triggers/runs/{run}/cancel": {
      parameters: [runParameter],
      post: operation("Cancel a Trigger and its pending agent operations", "runs:dispatch", object),
    },
    "/api/v1/triggers/runner/lease": {
      post: operation("Lease one run using a named runner credential", "runner", object),
    },
    "/api/v1/triggers/runner/runs/{organization}/{run}/{action}": {
      parameters: [
        { name: "organization", in: "path", required: true, schema: { type: "string" } },
        runParameter,
        {
          name: "action",
          in: "path",
          required: true,
          schema: {
            type: "string",
            enum: ["heartbeat", "operation", "complete-operation", "report", "log"],
          },
        },
      ],
      post: operation(
        "Record a worker operation using its ephemeral run lease",
        "run-lease",
        object,
      ),
    },
  },
};

/** Recognize canonical methods before auth, matching the existing public API's 404/405 contract. */
export function triggerRouteMethod(path: string[]): "GET" | "POST" | undefined {
  if (path.length === 0) return "GET";
  if (path.length === 1 && ["install", "validate", "runners"].includes(path[0]!)) return "POST";
  if (path[0] === "runner") {
    if (path.length === 2 && path[1] === "lease") return "POST";
    if (
      path.length === 5 &&
      path[1] === "runs" &&
      ["heartbeat", "operation", "complete-operation", "report", "log"].includes(path[4]!)
    )
      return "POST";
    return undefined;
  }
  if (path[0] === "runs") {
    if (path.length === 2) return "GET";
    if (path.length === 3 && path[2] === "cancel") return "POST";
    return undefined;
  }
  if (path.length === 2) {
    if (["runs", "revisions"].includes(path[1]!)) return "GET";
    if (["run", "events", "enabled"].includes(path[1]!)) return "POST";
  }
  if (path.length === 3 && path[1] === "revisions") return "GET";
  return undefined;
}
