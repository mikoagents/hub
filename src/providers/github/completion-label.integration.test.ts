import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { Octokit } from "octokit";
import { it } from "vitest";
import { z } from "zod";
import { createCompletionLabelWriter } from "./completion-label.js";

const target = { installationId: 42, repository: "owner/repo", number: 1053 };
const label = {
  name: "ai-complete",
  color: "0E8A16",
  description: "AI complete",
  review_body_contains: "clean result",
  exclusive_with: ["ai-failed"],
};

it("user gets an idempotent completion label while other labels and human decisions survive", async () => {
  // Given a repository without the completion label definition.
  const remote = await GitHubLabels.start();
  try {
    const sync = remote.writer();
    remote.labels.add("ai-failed");
    // When the current reviewed head is complete, including duplicate deliveries.
    await sync(target, "head", label, true);
    await sync(target, "head", label, true);
    // Then the API persists the configured definition and preserves unrelated labels.
    assert.deepEqual(remote.definitions.get(label.name), {
      name: label.name,
      color: label.color,
      description: label.description,
    });
    assert.deepEqual([...remote.labels], ["needs-human-review", label.name]);
    await sync(target, "stale-head", label, false);
    assert(remote.labels.has(label.name));
    await sync(target, "head", label, false);
    assert.deepEqual([...remote.labels], ["needs-human-review"]);
    await sync(target, "head", label, false);
    assert.deepEqual([...remote.labels], ["needs-human-review"]);
  } finally {
    await remote.close();
  }
});

it("user cannot receive stale completion when head changes during the write or GitHub denies permission", async () => {
  // Given an initially eligible PR and a real HTTP adapter.
  const remote = await GitHubLabels.start();
  try {
    const sync = remote.writer();
    // When another commit arrives during label association.
    remote.changeOnAdd = true;
    await sync(target, "head", label, true);
    // Then stale completion is removed, retaining the independent human requirement.
    assert.deepEqual([...remote.labels], ["needs-human-review"]);
    remote.denied = true;
    await assert.rejects(sync(target, "new-head", label, true), /denied/u);
    assert.deepEqual([...remote.labels], ["needs-human-review"]);
  } finally {
    await remote.close();
  }
});

class GitHubLabels {
  head = "head";
  labels = new Set(["needs-human-review"]);
  definitions = new Map<string, unknown>();
  changeOnAdd = false;
  denied = false;
  private origin = "";
  private server = createServer((request, response) => {
    void (async () => {
      response.setHeader("content-type", "application/json");
      if (this.denied) {
        response.writeHead(403);
        response.end(JSON.stringify({ message: "denied" }));
        return;
      }
      const path = new URL(request.url ?? "/", this.origin).pathname;
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = raw
        ? z
            .object({
              name: z.string().optional(),
              color: z.string().optional(),
              description: z.string().optional(),
              labels: z.array(z.string()).optional(),
            })
            .parse(JSON.parse(raw))
        : undefined;
      if (path === "/repos/owner/repo/pulls/1053") {
        response.end(
          JSON.stringify({
            head: { sha: this.head },
            state: "open",
            draft: false,
            labels: [...this.labels].map((name) => ({ name })),
          }),
        );
      } else if (path === "/repos/owner/repo/labels" && request.method === "POST" && body?.name) {
        this.definitions.set(body.name, body);
        response.writeHead(201);
        response.end(raw);
      } else if (path === "/repos/owner/repo/labels/ai-complete") {
        const definition = this.definitions.get(label.name);
        response.writeHead(definition ? 200 : 404);
        response.end(JSON.stringify(definition ?? { message: "Not found" }));
      } else if (path === "/repos/owner/repo/issues/1053/labels" && body?.labels) {
        for (const name of body.labels) this.labels.add(name);
        if (this.changeOnAdd) this.head = "new-head";
        response.end(JSON.stringify([...this.labels].map((name) => ({ name }))));
      } else if (
        path.startsWith("/repos/owner/repo/issues/1053/labels/") &&
        request.method === "DELETE"
      ) {
        this.labels.delete(decodeURIComponent(path.split("/").at(-1)!));
        response.end(JSON.stringify([...this.labels].map((name) => ({ name }))));
      } else {
        response.writeHead(404);
        response.end(JSON.stringify({ message: "Not found" }));
      }
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  static async start() {
    const remote = new GitHubLabels();
    remote.server.listen(0, "127.0.0.1");
    await once(remote.server, "listening");
    const address = remote.server.address();
    if (address === null || typeof address === "string") throw new Error("No API address");
    remote.origin = `http://127.0.0.1:${address.port}`;
    return remote;
  }
  writer() {
    const octokit = new Octokit({
      baseUrl: this.origin,
      throttle: { enabled: false },
      retry: { enabled: false },
    });
    return createCompletionLabelWriter({ createInstallationOctokit: async () => octokit });
  }
  async close() {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
  }
}
