import { z } from "zod";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchServer } from "../../http/node-server.js";
import { createWebhookSource } from "../github/webhook.js";
import { buildTrigger } from "./build.js";
import { executeTriggerJob } from "./runner.js";
import { setupCodeStorage } from "./test-fixture.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).toReversed()) await close();
});

describe("operator-owned GitHub review code project", () => {
  it("waits without occupying a worker, verifies formal receipts, supplements validation, repairs and independently reviews the new head", async () => {
    const f = await setup();
    const run = await f.deliver("pull_request", "candidate");
    await f.execute();
    assert.equal((await f.read(run)).status, "waiting");
    assert.equal(f.daemon.launches.length, 0);
    // CI's event arrives through the signed intake; replay re-reads actual evidence.
    f.remote.ci = "success";
    await f.deliver("workflow_run", "green");
    await f.pumpUntil(() => f.daemon.prompts.length === 1);
    await f.completeReview(0, { incomplete: true, comments: 1 });
    await f.pumpUntil(() => f.daemon.prompts.length === 2);
    assert.match(f.daemon.prompts[1]!, /Complete missing validation/u);
    await f.completeReview(1, { comments: 1 });
    await f.pumpUntil(() => f.daemon.prompts.length === 3);
    assert.match(f.daemon.prompts[2]!, /Address the formal Review/u);
    f.remote.head = "head-two";
    await f.finish(2, {});
    await f.pumpUntil(() => f.daemon.prompts.length === 4);
    assert.match(f.daemon.prompts[3]!, /Review .*head-two/u);
    const journal = await f
      .database()
      .triggerCode.transaction("code-org", (tx) => tx.operations(run));
    const children = journal.filter((op) => op.kind === "agent").map((op) => op.childRunId);
    assert.equal(new Set(children).size, 4);
    await f.completeReview(3, { comments: 0 });
    await f.pumpUntil(async () => (await f.read(run)).status === "succeeded");
    assert.equal(f.remote.labels.includes("review:complete"), true);
    assert.deepEqual((await f.read(run)).output, {
      head: "head-two",
      review: "https://github.test/reviews/4",
    });
    const duplicate = await f.deliver("pull_request", "candidate");
    assert.equal(duplicate, run);
    assert.equal(f.daemon.launches.length, 4);
  }, 90_000);

  it("rejects a fabricated Review receipt and never adds the completion label", async () => {
    const f = await setup();
    f.remote.ci = "success";
    const run = await f.deliver("pull_request", "receipt");
    await f.pumpUntil(() => f.daemon.prompts.length === 1);
    await f.completeReview(0, { comments: 0, forged: true });
    await f.pumpUntil(async () => (await f.read(run)).status === "failed");
    assert.match((await f.read(run)).error!, /does not prove an authorized formal Review/u);
    assert.deepEqual(f.remote.labels, []);
  }, 45_000);

  it("changes repair limits and external API behavior by deploying only policy code", async () => {
    const f = await setup({ maxFixRounds: 1, completeLabel: "custom:verified" });
    f.remote.ci = "failure";
    const run = await f.deliver("pull_request", "ci-fail");
    await f.pumpUntil(() => f.daemon.prompts.length === 1);
    assert.match(f.daemon.prompts[0]!, /Repair failing CI/u);
    f.remote.head = "repaired";
    f.remote.ci = "success";
    await f.finish(0, {});
    await f.pumpUntil(() => f.daemon.prompts.length === 2);
    await f.completeReview(1, { comments: 0 });
    await f.pumpUntil(async () => (await f.read(run)).status === "succeeded");
    assert.deepEqual(f.remote.labels, ["custom:verified"]);

    const stopped = await setup({ maxFixRounds: 0 });
    stopped.remote.ci = "failure";
    const limited = await stopped.deliver("pull_request", "ci-stop");
    await stopped.pumpUntil(async () => (await stopped.read(limited)).status === "failed");
    assert.equal(stopped.daemon.prompts.length, 0);
    assert.match((await stopped.read(limited)).error!, /CI repair round limit/u);
  }, 90_000);

  it("rejects unsigned input and skips untrusted, draft and stale candidates; bounds bot repair loops", async () => {
    const f = await setup();
    assert.equal(await f.unsigned(), 401);
    assert.equal(
      (await f.bundle().runtime.query("select * from trigger_code_runs")).rows.length,
      0,
    );
    f.remote.ci = "success";
    f.remote.author = "untrusted";
    const untrusted = await f.deliver("pull_request", "untrusted");
    await f.pumpUntil(async () => (await f.read(untrusted)).status === "skipped");
    f.remote.author = "replace-with-your-login";
    f.remote.draft = true;
    const draft = await f.deliver("pull_request", "draft");
    await f.pumpUntil(async () => (await f.read(draft)).status === "skipped");
    f.remote.draft = false;
    const stale = await f.deliver("pull_request", "stale", "old-head");
    await f.pumpUntil(async () => (await f.read(stale)).status === "skipped");
    assert.equal(f.daemon.prompts.length, 0);
    f.remote.botCommits = true;
    f.remote.ci = "failure";
    const limit = await f.deliver("pull_request", "bot-limit");
    await f.pumpUntil(async () => (await f.read(limit)).status === "failed");
    assert.match((await f.read(limit)).error!, /Consecutive bot commit limit/u);
    assert.equal(f.daemon.prompts.length, 0);
  }, 90_000);
});

interface Review {
  id: number;
  commit_id: string;
  html_url: string;
  state: string;
  body: string;
  submitted_at: string;
  user: { login: string };
  comments: number;
}
async function setup(policy: { maxFixRounds?: number; completeLabel?: string } = {}) {
  const f = await setupCodeStorage("embedded", undefined, true);
  cleanup.push(() => f.close());
  const remote = {
    head: "head-one",
    author: "replace-with-your-login",
    draft: false,
    ci: "pending",
    botCommits: false,
    labels: [] as string[],
    reviews: new Map<number, Review>(),
  };
  const server = createFetchServer(async (request) => {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== "Bearer local-github-test-credential")
      return new Response("Forbidden", { status: 403 });
    if (url.pathname.endsWith("/pulls/1"))
      return Response.json({
        number: 1,
        state: "open",
        draft: remote.draft,
        user: { login: remote.author },
        head: { sha: remote.head },
        base: { sha: "base" },
        labels: remote.labels.map((name) => ({ name })),
      });
    if (url.pathname.endsWith("/actions/runs"))
      return Response.json({
        total_count: 1,
        workflow_runs: [
          {
            id: 1,
            name: "CI",
            status: remote.ci === "pending" ? "in_progress" : "completed",
            conclusion: remote.ci === "pending" ? null : remote.ci,
          },
        ],
      });
    const reviewId = /\/reviews\/(\d+)/u.exec(url.pathname)?.[1];
    if (reviewId) {
      const review = remote.reviews.get(Number(reviewId));
      if (!review) return new Response("Not found", { status: 404 });
      return Response.json(
        url.pathname.endsWith("/comments")
          ? Array.from({ length: review.comments }, (_, id) => ({ id }))
          : review,
      );
    }
    if (url.pathname.includes("/commits/"))
      return Response.json({
        author: { login: remote.botCommits ? "replace-with-your-app[bot]" : "human" },
        parents: [{ sha: "parent" }],
      });
    if (url.pathname.endsWith("/labels") && request.method === "POST") {
      const body = z.object({ labels: z.array(z.string()) }).parse(await request.json());
      remote.labels.push(...body.labels);
      return Response.json(remote.labels);
    }
    if (url.pathname.includes("/labels/") && request.method === "DELETE") {
      remote.labels = [];
      return Response.json([]);
    }
    return new Response(`Unexpected test API path ${url.pathname}`, { status: 500 });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return originalFetch(
      url.origin === "https://api.github.com" ? `${origin}${url.pathname}${url.search}` : input,
      init,
    );
  });
  cleanup.push(async () => {
    spy.mockRestore();
  });
  const project = join(f.root, "project");
  await mkdir(project);
  for (const file of ["trigger.ts", "policy.ts", "review.ts"]) {
    let content = await readFile(resolve("examples/triggers/github-review", file), "utf8");
    if (file === "policy.ts")
      content = content
        .replace('daemon: "review-worker"', 'daemon: "devbox"')
        .replace("maxFixRounds: 3", `maxFixRounds: ${policy.maxFixRounds ?? 3}`)
        .replace(
          'completeLabel: "review:complete"',
          `completeLabel: ${JSON.stringify(policy.completeLabel ?? "review:complete")}`,
        );
    await writeFile(join(project, file), content);
  }
  const artifact = await buildTrigger(join(project, "trigger.ts"));
  const deployment = await f.service().deploy("code-org", artifact);
  const webhook = createWebhookSource("local-signing-key", {
    accept: (input) => f.database().acceptGitHubEvent(input),
    applyLifecycle: async () => {},
  });
  await webhook.start(async (event) => {
    await f.service().acceptProviderEvent(event);
  });
  cleanup.push(() => webhook.stop());
  async function deliver(
    event: string,
    delivery: string = randomUUID(),
    head = remote.head,
    sign = true,
  ) {
    const payload = JSON.stringify({
      action: event === "pull_request" ? "opened" : "completed",
      repository: { id: 9001, full_name: "example/project" },
      installation: { id: 42 },
      ...(event === "pull_request"
        ? {
            pull_request: {
              number: 1,
              head: { sha: head },
              draft: remote.draft,
              user: { login: remote.author },
            },
          }
        : { workflow_run: { head_sha: head, pull_requests: [{ number: 1 }] } }),
    });
    const response = await webhook.handle(
      new Request(`${f.url}/webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-event": event,
          "x-github-delivery": delivery,
          ...(sign
            ? {
                "x-hub-signature-256": `sha256=${createHmac("sha256", "local-signing-key").update(payload).digest("hex")}`,
              }
            : {}),
        },
        body: payload,
      }),
    );
    if (!sign) return response.status;
    assert.equal(response.status, 200, await response.text());
    const runs = await f
      .database()
      .triggerCode.transaction("code-org", (tx) => tx.listRuns(deployment.triggerId));
    const run = runs.find((value) => value.event.id === delivery);
    assert.ok(run);
    return run.id;
  }
  let runnerCredential: string | undefined;
  async function execute() {
    const runner = await f.service().runner(await runnerToken());
    const job = await f.service().lease(runner);
    if (job) await executeTriggerJob(job, { url: f.url, token: "unused", directory: f.root });
  }
  return {
    ...f,
    remote,
    execute,
    deliver: async (event: string, id: string, head?: string) => {
      const value = await deliver(event, id, head);
      return z.string().parse(value);
    },
    unsigned: () => deliver("pull_request", "unsigned", remote.head, false),
    async pumpUntil(check: () => boolean | Promise<boolean>) {
      await expect
        .poll(
          async () => {
            if (await check()) return true;
            await execute();
            return check();
          },
          { timeout: 20_000, interval: 50 },
        )
        .toBe(true);
    },
    async completeReview(
      index: number,
      options: { comments: number; incomplete?: boolean; forged?: boolean },
    ) {
      const id = index + 1;
      const review: Review = {
        id,
        commit_id: remote.head,
        html_url: `https://github.test/reviews/${id}`,
        state: options.comments ? "CHANGES_REQUESTED" : "COMMENTED",
        body: options.incomplete ? "REVIEW INCOMPLETE" : "Verified",
        submitted_at: new Date().toISOString(),
        user: { login: "replace-with-your-app[bot]" },
        comments: options.comments,
      };
      remote.reviews.set(id, review);
      const result = await f.finish(index, {
        output: {
          review_id: id,
          commit_sha: review.commit_id,
          url: options.forged ? "https://forged.test" : review.html_url,
          inline_comments: options.comments,
        },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result));
    },
  };
  async function runnerToken() {
    // Enrollment is stable across pump calls and independent of any production credential.
    runnerCredential ??= (await f.service().enroll("code-org", "local")).token;
    return runnerCredential;
  }
}
