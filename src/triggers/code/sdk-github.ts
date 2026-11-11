/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Repository results use GitHub's published endpoint types; pagination validates list envelopes. */
import type { Octokit } from "octokit";
import { createHash } from "node:crypto";
import type { TriggerEvent, TriggerValue } from "./sdk.js";
import { TriggerOperationError } from "./sdk-errors.js";

export type GitHubIssue = Awaited<ReturnType<Octokit["rest"]["issues"]["get"]>>["data"];
export type GitHubComment = Awaited<ReturnType<Octokit["rest"]["issues"]["getComment"]>>["data"];
export type GitHubPull = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];
export type GitHubFile = Awaited<ReturnType<Octokit["rest"]["pulls"]["listFiles"]>>["data"][number];
export type GitHubReview = Awaited<ReturnType<Octokit["rest"]["pulls"]["getReview"]>>["data"];
export type GitHubReviewComment = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listReviewComments"]>
>["data"][number];
export type GitHubWorkflow = Awaited<
  ReturnType<Octokit["rest"]["actions"]["listWorkflowRunsForRepo"]>
>["data"]["workflow_runs"][number];
export type GitHubCheck = Awaited<
  ReturnType<Octokit["rest"]["checks"]["listForRef"]>
>["data"]["check_runs"][number];
export type GitHubStatus = Awaited<
  ReturnType<Octokit["rest"]["repos"]["listCommitStatusesForRef"]>
>["data"][number];
export type GitHubCommit = Awaited<ReturnType<Octokit["rest"]["repos"]["getCommit"]>>["data"];
export type GitHubPermission = Awaited<
  ReturnType<Octokit["rest"]["repos"]["getCollaboratorPermissionLevel"]>
>["data"];

export interface GitHubRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: TriggerValue;
}
export interface GitHubResponse<T> {
  data: T;
  status: number;
  /** Safe response metadata, including Link, Retry-After and GitHub request/rate-limit ids. */
  headers: Record<string, string>;
}
export interface GitHubReadOptions {
  /** Opt-in, durable retries. Writes are never automatically retried. */
  retry?: { maxAttempts: number; initialDelayMs?: number; maxDelayMs?: number };
}
export interface GitHubListOptions extends GitHubReadOptions {
  maxPages?: number;
  maxItems?: number;
  perPage?: number;
}
export interface GitHubCommentReceipt {
  repository: string;
  number: number;
  id: number;
  url: string;
  body: string;
  deduplicated: boolean;
}
export interface FindGitHubCommentOptions extends GitHubListOptions {
  number: number;
  marker: string;
  author: string;
  body?: string;
}
export interface PublishGitHubCommentOptions extends FindGitHubCommentOptions {
  body: string;
}

interface GitHubTransport {
  request(
    id: string,
    grant: string,
    request: GitHubRequest & { response?: boolean },
  ): Promise<unknown>;
  sleep(id: string, milliseconds: number): Promise<void>;
  withLock<T>(id: string, key: string, action: () => Promise<T>): Promise<T>;
}

function integer(value: number, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new TypeError(`${name} must be an integer between 1 and ${max}`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function retryPolicy(method: string, options: GitHubReadOptions) {
  const retry = options.retry;
  if (retry !== undefined && method !== "GET")
    throw new TypeError("Automatic GitHub retries are only supported for GET requests");
  const attempts = integer(retry?.maxAttempts ?? 1, "maxAttempts", 10);
  const delay = retry?.initialDelayMs ?? 1000,
    maxDelay = retry?.maxDelayMs ?? 60_000;
  if (
    !Number.isSafeInteger(delay) ||
    delay < 0 ||
    !Number.isSafeInteger(maxDelay) ||
    maxDelay < delay ||
    maxDelay > 3_600_000
  )
    throw new TypeError("Invalid GitHub retry delay bounds");
  return { attempts, delay, maxDelay };
}

/** Parse verified event metadata without choosing mention spellings, authors or workflow policy. */
export function githubIssueComment(event: TriggerEvent) {
  if (event.source !== "github" || !event.type.startsWith("issue_comment.")) return null;
  const raw = object(event.payload),
    issue = object(raw["issue"]),
    comment = object(raw["comment"]);
  const user = object(comment["user"]),
    repository = object(raw["repository"])["full_name"];
  if (
    typeof repository !== "string" ||
    typeof comment["body"] !== "string" ||
    typeof user["login"] !== "string" ||
    typeof user["type"] !== "string" ||
    typeof comment["id"] !== "number" ||
    typeof issue["number"] !== "number" ||
    typeof raw["action"] !== "string" ||
    event.type !== `issue_comment.${raw["action"]}` ||
    (event.resource !== undefined && event.resource !== repository)
  )
    throw new TypeError("Invalid GitHub issue comment event");
  return {
    repository,
    number: integer(issue["number"], "Issue/PR number"),
    commentId: integer(comment["id"], "Comment id"),
    body: comment["body"],
    author: user["login"],
    authorType: user["type"],
    action: raw["action"],
    kind: issue["pull_request"] == null ? ("issue" as const) : ("pull_request" as const),
  };
}

export function createGitHubClient(transport: GitHubTransport) {
  async function execute<T>(
    id: string,
    grant: string,
    request: GitHubRequest & { response?: boolean },
    options: GitHubReadOptions = {},
  ): Promise<T> {
    const { attempts, delay, maxDelay } = retryPolicy(request.method, options);
    for (let attempt = 1; ; attempt++) {
      try {
        return (await transport.request(
          attempt === 1 ? id : `${id}:attempt:${attempt}`,
          grant,
          request,
        )) as T;
      } catch (error) {
        if (
          !(error instanceof TriggerOperationError) ||
          !error.failure.retryable ||
          attempt >= attempts
        )
          throw error;
        const wait = Math.max(
          Math.min(delay * 2 ** (attempt - 1), maxDelay),
          error.failure.retryAfterMs ?? 0,
        );
        // Never violate the server's Retry-After merely to fit the caller's retry budget.
        if (wait > maxDelay) throw error;
        await transport.sleep(`${id}:delay:${attempt + 1}`, wait);
      }
    }
  }
  const request = <T = TriggerValue>(
    id: string,
    grant: string,
    input: GitHubRequest,
    options?: GitHubReadOptions,
  ) => execute<T>(id, grant, input, options);
  const response = <T = TriggerValue>(
    id: string,
    grant: string,
    input: GitHubRequest,
    options?: GitHubReadOptions,
  ) => execute<GitHubResponse<T>>(id, grant, { ...input, response: true }, options);
  async function paginate<T = TriggerValue>(
    id: string,
    grant: string,
    options: GitHubListOptions & { path: string; itemsKey?: string },
  ): Promise<T[]> {
    const maxPages = integer(options.maxPages ?? 10, "maxPages", 100);
    const maxItems = integer(options.maxItems ?? 1000, "maxItems", 10_000);
    const perPage = integer(options.perPage ?? 100, "perPage", 100);
    const first = new URL(options.path, "https://api.github.com");
    if (first.origin !== "https://api.github.com" || !options.path.startsWith("/repos/"))
      throw new TypeError("GitHub pagination requires a repository API path");
    first.searchParams.set("per_page", String(perPage));
    first.searchParams.set("page", "1");
    let next = first;
    const seen = new Set<string>(),
      rows: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      if (seen.has(next.href)) throw new Error("GitHub pagination repeated a page");
      seen.add(next.href);
      const result = await response<unknown>(
        `${id}:${page}`,
        grant,
        { method: "GET", path: next.pathname + next.search },
        options,
      );
      const envelope = object(result.data);
      const items = options.itemsKey === undefined ? result.data : envelope[options.itemsKey];
      if (!Array.isArray(items)) throw new Error("GitHub pagination expected an array");
      if (rows.length + items.length > maxItems)
        throw new Error("GitHub pagination exceeds maxItems");
      rows.push(...(items as T[]));
      const link = /<([^>]+)>\s*;\s*rel="next"/u.exec(result.headers["link"] ?? "")?.[1];
      if (link === undefined) {
        if (typeof envelope["total_count"] === "number" && envelope["total_count"] > rows.length)
          throw new Error("GitHub pagination is incomplete: missing next page");
        return rows;
      }
      next = new URL(link);
      if (
        next.origin !== first.origin ||
        next.origin !== "https://api.github.com" ||
        next.pathname !== first.pathname
      )
        throw new Error("GitHub pagination changed endpoint");
    }
    throw new Error("GitHub pagination exceeds maxPages; partial data was not returned");
  }
  function repo(grant: string, repository: string) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) ||
      repository.split("/").some((part) => part === "." || part === "..")
    )
      throw new TypeError("Expected a GitHub owner/repository");
    const base = `/repos/${repository}`;
    const get = <T>(id: string, path: string, options?: GitHubReadOptions) =>
      request<T>(id, grant, { method: "GET", path: base + path }, options);
    const list = <T>(id: string, path: string, options?: GitHubListOptions, itemsKey?: string) =>
      paginate<T>(id, grant, {
        ...options,
        path: base + path,
        ...(itemsKey === undefined ? {} : { itemsKey }),
      });
    const number = (value: number) => integer(value, "Issue/PR number");
    const comments = {
      get: (id: string, comment: number, options?: GitHubReadOptions) =>
        get<GitHubComment>(id, `/issues/comments/${integer(comment, "Comment id")}`, options),
      list: (id: string, item: number, options?: GitHubListOptions) =>
        list<GitHubComment>(id, `/issues/${number(item)}/comments`, options),
      async find(
        id: string,
        options: FindGitHubCommentOptions,
      ): Promise<GitHubCommentReceipt | null> {
        validateMarker(options);
        const matches = (await comments.list(`${id}:list`, options.number, options)).filter(
          (row) => row.user?.login === options.author && row.body?.includes(options.marker),
        );
        if (matches.length > 1)
          throw new Error("Multiple GitHub comments have the same author and marker");
        if (matches[0] === undefined) return null;
        const current = await comments.get(`${id}:readback`, matches[0].id, options);
        return { ...verifyComment(repository, current, options), deduplicated: true };
      },
      async publishOnce(
        id: string,
        options: PublishGitHubCommentOptions,
      ): Promise<GitHubCommentReceipt> {
        validateMarker(options);
        if (!options.body.trim() || options.body.includes(options.marker))
          throw new TypeError("Expected nonempty comment text without its publication marker");
        const expected = { ...options, body: `${options.body}\n\n${options.marker}` };
        const lock = createHash("sha256")
          .update(`${repository}#${options.number}:${options.marker}`)
          .digest("hex");
        return transport.withLock(`${id}:lock`, `github-comment:${lock}`, async () => {
          const existing = await comments.find(`${id}:before`, expected);
          if (existing !== null) return existing;
          let published: GitHubComment;
          try {
            published = await request<GitHubComment>(`${id}:publish`, grant, {
              method: "POST",
              path: `${base}/issues/${options.number}/comments`,
              body: { body: expected.body },
            });
          } catch (error) {
            // A Hub transport or credential-cleanup error can also obscure a completed write.
            // Reconcile every failed POST; never issue another POST without a new author decision.
            const recovered = await comments.find(`${id}:recover`, expected);
            if (recovered !== null) return recovered;
            throw error;
          }
          const readback = await comments.get(
            `${id}:readback`,
            integer(published.id, "Published comment id"),
            options,
          );
          return verifyComment(repository, readback, expected);
        });
      },
    };
    return {
      issues: {
        get: (id: string, item: number, options?: GitHubReadOptions) =>
          get<GitHubIssue>(id, `/issues/${number(item)}`, options),
      },
      comments,
      pulls: {
        get: (id: string, item: number, options?: GitHubReadOptions) =>
          get<GitHubPull>(id, `/pulls/${number(item)}`, options),
        files: (id: string, item: number, options?: GitHubListOptions) =>
          list<GitHubFile>(id, `/pulls/${number(item)}/files`, options),
        reviews: (id: string, item: number, options?: GitHubListOptions) =>
          list<GitHubReview>(id, `/pulls/${number(item)}/reviews`, options),
        review: (id: string, item: number, review: number, options?: GitHubReadOptions) =>
          get<GitHubReview>(
            id,
            `/pulls/${number(item)}/reviews/${integer(review, "Review id")}`,
            options,
          ),
        comments: (id: string, item: number, options?: GitHubListOptions) =>
          list<GitHubReviewComment>(id, `/pulls/${number(item)}/comments`, options),
        reviewComments: (id: string, item: number, review: number, options?: GitHubListOptions) =>
          list<GitHubReviewComment>(
            id,
            `/pulls/${number(item)}/reviews/${integer(review, "Review id")}/comments`,
            options,
          ),
      },
      collaborators: {
        permission: (id: string, login: string, options?: GitHubReadOptions) =>
          get<GitHubPermission>(
            id,
            `/collaborators/${encodeURIComponent(login)}/permission`,
            options,
          ),
      },
      commits: {
        get: (id: string, ref: string, options?: GitHubReadOptions) =>
          get<GitHubCommit>(id, `/commits/${encodeURIComponent(ref)}`, options),
      },
      actions: {
        runs: (
          id: string,
          input: { headSha: string; event?: string },
          options?: GitHubListOptions,
        ) =>
          list<GitHubWorkflow>(
            id,
            `/actions/runs?${new URLSearchParams({ head_sha: input.headSha, ...(input.event === undefined ? {} : { event: input.event }) })}`,
            options,
            "workflow_runs",
          ),
      },
      checks: {
        list: (id: string, ref: string, options?: GitHubListOptions) =>
          list<GitHubCheck>(
            id,
            `/commits/${encodeURIComponent(ref)}/check-runs?filter=latest`,
            options,
            "check_runs",
          ),
      },
      statuses: {
        list: (id: string, ref: string, options?: GitHubListOptions) =>
          list<GitHubStatus>(id, `/commits/${encodeURIComponent(ref)}/statuses`, options),
      },
    };
  }
  return { request, response, paginate, repo };
}

function validateMarker(options: FindGitHubCommentOptions) {
  if (!/^<!-- [^\r\n]{1,500} -->$/u.test(options.marker) || !options.author.trim())
    throw new TypeError("Comment publication requires an explicit HTML marker and expected author");
  integer(options.number, "Issue/PR number");
}
function verifyComment(
  repository: string,
  comment: GitHubComment,
  options: FindGitHubCommentOptions,
): GitHubCommentReceipt {
  const validUrls = ["issues", "pull"].map(
    (kind) =>
      `https://github.com/${repository}/${kind}/${options.number}#issuecomment-${comment.id}`,
  );
  if (
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    comment.user?.login !== options.author ||
    comment.issue_url !== `https://api.github.com/repos/${repository}/issues/${options.number}` ||
    typeof comment.body !== "string" ||
    !comment.body.includes(options.marker) ||
    (options.body !== undefined && comment.body !== options.body) ||
    !validUrls.includes(comment.html_url)
  )
    throw new Error("GitHub comment readback did not verify author, target, body and URL");
  return {
    repository,
    number: options.number,
    id: comment.id,
    url: comment.html_url,
    body: comment.body,
    deduplicated: false,
  };
}

export type TriggerGitHub = ReturnType<typeof createGitHubClient>;
export type GitHubRepository = ReturnType<TriggerGitHub["repo"]>;
