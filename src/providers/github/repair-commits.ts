import type { Octokit } from "octokit";
import type { GitHubPullRequestPolicy } from "../../triggers/github/pull-request-policy.js";
import type { PullRequestSnapshot } from "../../triggers/github/pull-request-gate.js";

/** Follow the exact first-parent chain; PR commit listings can mix merged side branches. */
export async function repairCommitEvidence(
  octokit: Octokit,
  owner: string,
  repo: string,
  head: string,
  limit: GitHubPullRequestPolicy["repair_limit"],
): Promise<Pick<PullRequestSnapshot, "repairCommitCount">> {
  if (limit === undefined) return {};
  let ref = head;
  for (let count = 0; count < limit.max_consecutive_commits; count += 1) {
    const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner,
      repo,
      ref,
    });
    if (commit.sha !== ref) throw new Error("GitHub repair commit identity mismatch");
    // An unlinked author is not evidence of a human reset. Label reconciliation can
    // still proceed, but routing fails closed until commit attribution is available.
    if (commit.author == null) return {};
    if (commit.author.login !== limit.from_user) return { repairCommitCount: count };
    const parent = commit.parents[0];
    if (parent === undefined) return { repairCommitCount: count + 1 };
    ref = parent.sha;
  }
  return { repairCommitCount: limit.max_consecutive_commits };
}
