import { z } from "zod";
import type { GitHubAuth } from "../../auth/github.js";
import type {
  PullRequestSnapshot,
  ReadPullRequest,
} from "../../triggers/github/pull-request-gate.js";

const AuthorSchema = z.object({ login: z.string(), __typename: z.string() }).nullable();
const ThreadPageSchema = z.object({
  repository: z
    .object({
      pullRequest: z
        .object({
          state: z.string(),
          isDraft: z.boolean(),
          headRefOid: z.string(),
          baseRefOid: z.string(),
          headRepository: z.object({ nameWithOwner: z.string() }).nullable(),
          baseRepository: z.object({ nameWithOwner: z.string() }),
          reviewThreads: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(
              z.object({
                id: z.string(),
                isResolved: z.boolean(),
                comments: z.object({
                  nodes: z.array(z.object({ body: z.string(), author: AuthorSchema })),
                }),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export const PULL_REQUEST_READINESS_QUERY = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    state isDraft headRefOid baseRefOid
    headRepository { nameWithOwner } baseRepository { nameWithOwner }
    reviewThreads(first:100,after:$cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved comments(first:1) { nodes { body author { login __typename } } } }
    }
  } }
}`;

/** All input is read using this event's installation; failures never fall back to a model. */
export function createPullRequestReader(
  auth: Pick<GitHubAuth, "createInstallationOctokit">,
): ReadPullRequest {
  return async (target) => {
    const [owner, repo] = target.repository.split("/");
    if (owner === undefined || repo === undefined) throw new Error("Invalid GitHub repository");
    const octokit = await auth.createInstallationOctokit(target.installationId);
    let snapshot: PullRequestSnapshot | undefined;
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response: unknown = await octokit.graphql(PULL_REQUEST_READINESS_QUERY, {
        owner,
        repo,
        number: target.number,
        cursor,
      });
      const pull = ThreadPageSchema.parse(response).repository?.pullRequest;
      if (pull == null) throw new Error("GitHub pull request unavailable");
      if (
        snapshot !== undefined &&
        (snapshot.headSha !== pull.headRefOid || snapshot.baseSha !== pull.baseRefOid)
      )
        throw new Error("GitHub pull request changed during pagination");
      snapshot ??= {
        state: pull.state,
        isDraft: pull.isDraft,
        headSha: pull.headRefOid,
        baseSha: pull.baseRefOid,
        sameRepository: pull.headRepository?.nameWithOwner === pull.baseRepository.nameWithOwner,
        reviews: [],
        threads: [],
        workflows: [],
      };
      appendThreads(snapshot, pull.reviewThreads.nodes);
      if (!pull.reviewThreads.pageInfo.hasNextPage) break;
      const next = pull.reviewThreads.pageInfo.endCursor;
      if (next === null || next === cursor || page === 9)
        throw new Error("GitHub review thread pagination limit exceeded");
      cursor = next;
    }
    if (snapshot === undefined) throw new Error("GitHub pull request unavailable");
    const headSha = snapshot.headSha;
    let reviewCount = 0;
    const [reviews, workflows] = await Promise.all([
      octokit.paginate(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: target.number,
          per_page: 100,
        },
        (response) => {
          reviewCount += response.data.length;
          if (reviewCount >= 1000) throw new Error("GitHub review pagination limit exceeded");
          return response.data;
        },
      ),
      octokit.paginate("GET /repos/{owner}/{repo}/actions/runs", {
        owner,
        repo,
        head_sha: headSha,
        event: "pull_request",
        per_page: 100,
      }),
    ]);
    // The filtered Actions endpoint truncates search results at 1,000. Never infer readiness
    // from incomplete evidence; an operator can investigate an exceptional oversized PR.
    if (workflows.length >= 1000) throw new Error("GitHub workflow search limit exceeded");
    snapshot.reviews = reviews.map((review) => ({
      id: review.id,
      author: review.user?.login ?? "",
      headSha: review.commit_id ?? "",
      state: review.state.toUpperCase(),
      body: review.body ?? "",
    }));
    snapshot.workflows = workflows.map((run) => ({
      id: run.id,
      workflowId: run.workflow_id,
      name: run.name ?? "",
      attempt: run.run_attempt ?? 1,
      headSha: run.head_sha,
      status: run.status ?? "",
      conclusion: run.conclusion,
    }));
    if (target.includeChecks) {
      let checkCount = 0;
      const [checks, statuses] = await Promise.all([
        octokit.paginate(
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          {
            owner,
            repo,
            ref: headSha,
            per_page: 100,
            filter: "latest",
          },
          (response) => {
            checkCount += response.data.length;
            if (checkCount >= 1000)
              throw new Error("GitHub completion check pagination limit exceeded");
            return response.data;
          },
        ),
        octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
          owner,
          repo,
          ref: headSha,
          per_page: 100,
        }),
      ]);
      if (checks.length >= 1000 || statuses.data.total_count > statuses.data.statuses.length)
        throw new Error("GitHub completion checks pagination limit exceeded");
      snapshot.checks = checks.map((check) => ({
        status: check.status,
        conclusion: check.conclusion,
      }));
      snapshot.statuses = statuses.data.statuses.map((status) => ({ state: status.state }));
    }
    return snapshot;
  };
}

function appendThreads(
  snapshot: PullRequestSnapshot,
  threads: NonNullable<
    NonNullable<z.infer<typeof ThreadPageSchema>["repository"]>["pullRequest"]
  >["reviewThreads"]["nodes"],
): void {
  for (const thread of threads) {
    const first = thread.comments.nodes[0];
    if (first == null) throw new Error("GitHub review thread has no root comment");
    const author =
      first.author?.__typename === "Bot"
        ? `${first.author.login.replace(/\[bot\]$/u, "")}[bot]`
        : (first.author?.login ?? "");
    snapshot.threads.push({
      id: thread.id,
      author,
      body: first.body,
      resolved: thread.isResolved,
    });
  }
}
