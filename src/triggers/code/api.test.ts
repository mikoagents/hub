import assert from "node:assert/strict";
import { describe, it } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { createMemoryDatabase } from "../../db/memory.js";
import { createPublicApi } from "../../public-api/index.js";
import { artifactDigest } from "./contract.js";
import { createTriggerCodeApi } from "./api.js";
import { TriggerCodeService } from "./service.js";
import { triggerCodeOpenApiDocument } from "./openapi.js";

function setup() {
  const database = createMemoryDatabase({ organizationIds: ["org", "other"] });
  const service = new TriggerCodeService(database, {
    ensure: async () => {},
    cancel: async () => {},
    github: async () => null,
  });
  const api = createTriggerCodeApi(
    service,
    {
      status: "enabled",
      authenticator: {
        async authorize(request, scope) {
          const token = request.headers.get("authorization");
          if (token === null) return { status: "unauthorized" };
          if (token === "Bearer read" && scope !== "configuration:validate")
            return { status: "forbidden" };
          return {
            status: "authorized",
            access: {
              kind: "apiKey",
              credentialId: "test",
              organizationId: token === "Bearer other" ? "other" : "org",
              scopes: [scope],
            },
          };
        },
      },
    },
    createPublicApi({ status: "unavailable" }, null),
  );
  const request = (
    path: string,
    body?: unknown,
    token = "operator",
    method = body === undefined ? "GET" : "POST",
  ) =>
    new Request(`http://hub.test/api/v1/triggers${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const handle = (path: string, body?: unknown, token?: string, method?: string) =>
    api.handle(request(path, body, token, method));
  return { api, service, request, handle };
}
function artifact() {
  const body = {
    format: "trigger-code-v1" as const,
    manifest: {
      name: "example",
      on: [{ source: "manual", event: "run" }],
      runner: "local",
      grants: {},
      limits: { maxRuntime: "1h" },
    },
    code: 'throw new Error("Hub must never evaluate this module")',
    sources: [{ path: "trigger.js", content: "source" }],
  };
  return { ...body, digest: artifactDigest(body) };
}

describe("Trigger API", () => {
  it("enforces scopes and canonical methods, reports malformed paths and JSON with request IDs", async () => {
    const f = setup();
    assert.equal((await f.handle("", undefined, "")).status, 401);
    assert.equal((await f.handle("/install", { artifact: artifact() }, "read")).status, 403);
    const wrong = await f.handle("/validate", undefined, "operator", "DELETE");
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    assert.equal((await f.handle("/%ff/run", {})).status, 400);
    const malformed = await f.api.handle(
      new Request("http://hub.test/api/v1/triggers/install", {
        method: "POST",
        headers: { authorization: "Bearer operator" },
        body: "{",
      }),
    );
    assert.equal(malformed.status, 400);
    assert.ok(malformed.headers.get("x-request-id"));
    assert.match(malformed.headers.get("content-type")!, /application\/problem\+json/u);
  });

  it("uses the same code deployment boundary for direct operations; lists metadata without source bundles and isolates tenants", async () => {
    const f = setup(),
      code = artifact();
    const installed = await f.api.handleOperation(
      "installTrigger",
      f.request("/ignored", { artifact: code }),
    );
    assert.equal(installed.status, 201);
    const validated = await f.api.handleOperation(
      "validateTrigger",
      f.request("/ignored", { artifact: code }, "read"),
    );
    assert.equal(validated.status, 200);
    const response = await f.api.handleOperation("listTriggers", f.request("/ignored"));
    assert.deepEqual(await response.json(), {
      triggers: [
        {
          id: (await f.service.trigger("org", "example")).id,
          name: "example",
          enabled: true,
          format: "code",
          revisionId: (await f.service.trigger("org", "example")).activeRevisionId,
          version: 1,
          manifest: code.manifest,
          digest: code.digest,
        },
      ],
    });
    assert.equal((await f.handle("/example/run", {}, "read")).status, 403);
    assert.equal((await f.handle("/example/run", {}, "other")).status, 404);
    assert.equal(
      (await f.handle("/install", { artifact: { ...code, code: "altered" } })).status,
      422,
    );
    assert.equal((await f.handle("/install", { yaml: "name: obsolete" })).status, 422);
    assert.deepEqual(await (await f.handle("", undefined, "other")).json(), { triggers: [] });
    const started = await f.handle("/example/run", { deliveryKey: "once", input: { n: 1 } });
    assert.equal(started.status, 201);
    assert.equal(
      (await f.handle("/example/run", { deliveryKey: "once", input: { n: 1 } })).status,
      200,
    );
    const runs = await f.service.database.triggerCode.transaction("org", (tx) => tx.listRuns());
    assert.equal((await f.handle(`/runs/${runs[0]!.id}`, undefined, "other")).status, 404);
  });

  it("publishes a valid OpenAPI contract for code and runner routes", async () => {
    const f = setup();
    const document = triggerCodeOpenApiDocument;
    assert.equal(f.api.openapi().status, 200);
    await SwaggerParser.validate(document);
    assert.ok(document.paths["/api/v1/triggers/runner/lease"]);
  });
});
