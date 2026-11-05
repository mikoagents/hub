import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { once } from "node:events";
import { Octokit } from "octokit";
import { it } from "vitest";
import { createPullRequestReader } from "./pull-request-reader.js";

// A local HTTP GitHub boundary exercises the actual Octokit transport and pagination.
// The query and response contract is additionally checked read-only against GitHub PR #1053;
// this suite never launches an AI agent or writes to GitHub.
it("user reads complete trusted feedback across GitHub pages without mixing heads", async () => {
  // Given a GitHub API with paginated threads, reviews and CI runs.
  const remote = await GitHubApi.start();
  try {
    const read = remote.reader();
    // When Hub reads that pull request through its production API adapter.
    const snapshot = await read({ installationId: 42, repository: "owner/repo", number: 1053 });
    // Then all pages are present, including canonical bot identity and the CI attempt.
    assert.equal(snapshot.headSha, "head");
    assert.equal(snapshot.sameRepository, true);
    assert.deepEqual(
      snapshot.threads.map((x) => [x.id, x.author, x.resolved]),
      [
        ["first", "reviewer[bot]", false],
        ["second", "human", true],
      ],
    );
    assert.equal(snapshot.reviews.length, 101);
    assert.deepEqual(
      snapshot.workflows.map((x) => [x.name, x.attempt, x.conclusion]),
      [
        ["Coverage", 2, "failure"],
        ["Repository Checks", 1, "success"],
      ],
    );
    const complete = await read({
      installationId: 42,
      repository: "owner/repo",
      number: 1053,
      includeChecks: true,
    });
    assert.deepEqual(complete.checks, [{ status: "completed", conclusion: "success" }]);
    assert.deepEqual(complete.statuses, [{ state: "success" }]);
    // A head changing between pages must not be treated as a coherent ready snapshot.
    remote.changedHead = true;
    await assert.rejects(
      read({ installationId: 42, repository: "owner/repo", number: 1053 }),
      /changed during pagination/u,
    );
  } finally {
    await remote.close();
  }
});

it("user fails closed when GitHub cannot supply complete repair evidence", async () => {
  // Given a GitHub server whose permissions or pagination can be unavailable.
  const remote = await GitHubApi.start();
  try {
    const read = remote.reader();
    // When the API denies access or provides a broken pagination cursor.
    remote.denied = true;
    await assert.rejects(read({ installationId: 42, repository: "owner/repo", number: 1053 }));
    remote.denied = false;
    remote.brokenCursor = true;
    await assert.rejects(
      read({ installationId: 42, repository: "owner/repo", number: 1053 }),
      /pagination limit/u,
    );
    // Then invalid repository targets are also refused before any repair can start.
    await assert.rejects(
      read({ installationId: 42, repository: "invalid", number: 1053 }),
      /Invalid GitHub repository/u,
    );
  } finally {
    await remote.close();
  }
});

it("user bounds automatic repairs by exact first-parent commits and keeps human resets separate", async () => {
  // Given a merge whose first-parent chain has three automation-authored commits.
  const remote = await GitHubApi.start();
  try {
    remote.commits = {
      head: {
        sha: "head",
        author: { login: "repairer[bot]" },
        parents: [{ sha: "second" }, { sha: "human" }],
      },
      second: { sha: "second", author: { login: "repairer[bot]" }, parents: [{ sha: "third" }] },
      third: { sha: "third", author: { login: "repairer[bot]" }, parents: [{ sha: "human" }] },
    };
    const target = {
      installationId: 42,
      repository: "owner/repo",
      number: 1053,
      repairLimit: { from_user: "repairer[bot]", max_consecutive_commits: 3 },
    };
    // When the production reader loads that PR through the actual HTTP transport.
    const read = remote.reader();
    assert.equal((await read(target)).repairCommitCount, 3);
    remote.commits["second"]!.author = { login: "human" };
    assert.equal((await read(target)).repairCommitCount, 1);
    remote.commits["head"]!.author = { login: "human" };
    assert.equal((await read(target)).repairCommitCount, 0);
    // Then unlinked authors cannot reset the chain, and mismatched/error evidence fails closed.
    remote.commits["head"]!.author = null;
    assert.equal((await read(target)).repairCommitCount, undefined);
    remote.commits["head"]!.sha = "different";
    await assert.rejects(read(target), /identity mismatch/u);
    remote.commits["head"]!.sha = "head";
    remote.commits["head"]!.author = { login: "repairer[bot]" };
    remote.commits["head"]!.parents = [];
    assert.equal((await read(target)).repairCommitCount, 1);
    remote.commits["head"]!.parents = [{ sha: "unavailable" }];
    await assert.rejects(read(target));
  } finally {
    await remote.close();
  }
});

class GitHubApi {
  commits: Record<
    string,
    { sha: string; author: { login: string } | null; parents: { sha: string }[] }
  > = {};
  changedHead = false;
  denied = false;
  brokenCursor = false;
  private origin = "";
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.denied) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Read denied" }));
      return;
    }
    const url = new URL(request.url ?? "/", this.origin);
    response.setHeader("content-type", "application/json");
    const commitRef = /^\/repos\/owner\/repo\/commits\/([^/]+)$/u.exec(url.pathname)?.[1];
    if (commitRef !== undefined) {
      this.sendCommit(commitRef, response);
      return;
    }
    if (url.pathname.endsWith("/check-runs")) {
      response.end(
        JSON.stringify({
          total_count: 1,
          check_runs: [{ status: "completed", conclusion: "success" }],
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/status")) {
      response.end(JSON.stringify({ total_count: 1, statuses: [{ state: "success" }] }));
      return;
    }
    if (url.pathname === "/graphql") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const query = z
        .object({ variables: z.object({ cursor: z.string().nullable() }) })
        .parse(JSON.parse(body));
      response.end(JSON.stringify(this.threadPage(typeof query.variables.cursor === "string")));
      return;
    }
    if (url.pathname === "/repos/owner/repo/pulls/1053/reviews") {
      const later = url.searchParams.get("page") === "2";
      if (!later)
        response.setHeader(
          "link",
          `<${this.origin}${url.pathname}?page=2&per_page=100>; rel="next"`,
        );
      response.end(
        JSON.stringify(
          Array.from({ length: later ? 1 : 100 }, (_, index) => ({
            id: later ? 101 : index + 1,
            user: { login: "reviewer[bot]" },
            commit_id: "head",
            state: "COMMENTED",
            body: "review protocol",
          })),
        ),
      );
      return;
    }
    if (url.pathname === "/repos/owner/repo/actions/runs") {
      const later = url.searchParams.get("page") === "2";
      if (!later)
        response.setHeader(
          "link",
          `<${this.origin}${url.pathname}?page=2&per_page=100>; rel="next"`,
        );
      response.end(
        JSON.stringify({
          total_count: 2,
          workflow_runs: [
            {
              id: later ? 2 : 1,
              workflow_id: later ? 2 : 1,
              name: later ? "Repository Checks" : "Coverage",
              run_attempt: later ? 1 : 2,
              head_sha: "head",
              status: "completed",
              conclusion: later ? "success" : "failure",
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "Not found" }));
  }
  private sendCommit(ref: string, response: ServerResponse) {
    const commit = this.commits[ref];
    response.statusCode = commit === undefined ? 404 : 200;
    response.end(JSON.stringify(commit ?? { message: "Commit unavailable" }));
  }
  private threadPage(later: boolean) {
    return {
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            isDraft: false,
            headRefOid: later && this.changedHead ? "different" : "head",
            baseRefOid: "base",
            headRepository: { nameWithOwner: "owner/repo" },
            baseRepository: { nameWithOwner: "owner/repo" },
            reviewThreads: {
              pageInfo: { hasNextPage: !later, endCursor: this.brokenCursor ? null : "cursor" },
              nodes: [
                {
                  id: later ? "second" : "first",
                  isResolved: later,
                  comments: {
                    nodes: [
                      {
                        body: "Finding",
                        author: later
                          ? { login: "human", __typename: "User" }
                          : { login: "reviewer", __typename: "Bot" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    };
  }
  static async start() {
    const api = new GitHubApi();
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    const address = api.server.address();
    if (address === null || typeof address === "string") throw new Error("No API address");
    api.origin = `http://127.0.0.1:${address.port}`;
    return api;
  }
  reader() {
    const octokit = new Octokit({
      baseUrl: this.origin,
      throttle: { enabled: false },
      retry: { enabled: false },
    });
    return createPullRequestReader({ createInstallationOctokit: async () => octokit });
  }
  async close() {
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
  }
}
