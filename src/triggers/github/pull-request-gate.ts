import { createHash } from "node:crypto";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";
import { classifyGitHubEvent } from "./classification.js";
import type { GitHubPullRequestPolicy } from "./pull-request-policy.js";

export interface PullRequestSnapshot {
  state: string;
  isDraft: boolean;
  headSha: string;
  baseSha: string;
  sameRepository: boolean;
  reviews: { id: number; author: string; headSha: string; state: string; body: string }[];
  threads: { id: string; author: string; body: string; resolved: boolean }[];
  workflows: {
    id: number;
    workflowId: number;
    name: string;
    attempt: number;
    headSha: string;
    status: string;
    conclusion: string | null;
  }[];
}

export interface PullRequestTarget {
  installationId: number;
  repository: string;
  number: number;
}
export type ReadPullRequest = (target: PullRequestTarget) => Promise<PullRequestSnapshot>;

/** Equivalent review and CI deliveries share this identity before an execution is created. */
export function readyPullRequestKey(
  target: Pick<PullRequestTarget, "repository" | "number">,
  expectedHead: string,
  policy: GitHubPullRequestPolicy,
  snapshot: PullRequestSnapshot,
): string | undefined {
  if (!currentPullRequest(snapshot, expectedHead)) return undefined;
  const review = snapshot.reviews
    .filter(
      (item) =>
        item.author === policy.review.from_user &&
        item.headSha === expectedHead &&
        item.state !== "PENDING" &&
        item.state !== "DISMISSED",
    )
    .sort((a, b) => b.id - a.id)[0];
  if (review === undefined || !review.body.includes(policy.review.body_contains)) return undefined;

  const latest = new Map<number, PullRequestSnapshot["workflows"][number]>();
  for (const run of snapshot.workflows) {
    if (run.headSha !== expectedHead) continue;
    const previous = latest.get(run.workflowId);
    if (
      previous === undefined ||
      run.id > previous.id ||
      (run.id === previous.id && run.attempt > previous.attempt)
    )
      latest.set(run.workflowId, run);
  }
  const workflows = [...latest.values()];
  if (policy.required_workflows.some((name) => !workflows.some((run) => run.name === name)))
    return undefined;
  if (workflows.some((run) => run.status !== "completed" || run.conclusion === null))
    return undefined;
  const failed = workflows.filter(
    (run) => !["success", "neutral", "skipped"].includes(run.conclusion!),
  );
  const threads = snapshot.threads.filter((thread) => policy.feedback_from.includes(thread.author));
  const attention = snapshot.reviews.filter(
    (item) =>
      policy.feedback_from.includes(item.author) &&
      item.headSha === expectedHead &&
      (item.state === "CHANGES_REQUESTED" ||
        (item.state !== "DISMISSED" &&
          item.state !== "PENDING" &&
          item.body.includes("CHANGES REQUESTED"))),
  );
  if (failed.length === 0 && !threads.some((thread) => !thread.resolved) && attention.length === 0)
    return undefined;

  // Resolutions and unrelated successful workflows do not introduce new repair input.
  // Keep trusted thread content in the identity even after resolution so that resolving
  // one thread cannot make a remaining old finding look like an entirely new batch.
  const evidence = {
    target,
    head: expectedHead,
    base: snapshot.baseSha,
    policy,
    review: [review.id, review.body],
    threads: threads
      .map((thread) => [thread.id, thread.body])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    attention: attention
      .map((item) => [item.id, item.body])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    failed: failed
      .map((run) => [run.workflowId, run.id, run.attempt, run.conclusion])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return `github.pull_request:${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}`;
}

export function currentPullRequest(snapshot: PullRequestSnapshot, expectedHead: string): boolean {
  return (
    snapshot.state === "OPEN" &&
    !snapshot.isDraft &&
    snapshot.sameRepository &&
    snapshot.headSha === expectedHead
  );
}

export async function matchPullRequestReadiness(
  event: NormalizedGitHubEvent,
  policy: GitHubPullRequestPolicy,
  read: ReadPullRequest | undefined,
): Promise<{ key: string; readiness: { number: number; headSha: string } } | undefined> {
  const classified = classifyGitHubEvent(event);
  const number = classified.item?.number;
  const review = event.payload["review"];
  const headSha =
    event.type === "pull_request_review" &&
    typeof review === "object" &&
    review !== null &&
    "commit_id" in review &&
    typeof review.commit_id === "string"
      ? review.commit_id
      : classified.pullRequest?.headSha;
  if (number == null || headSha == null) return undefined;
  if (read === undefined) throw new Error("GitHub readiness reader unavailable");
  const target = { installationId: event.installationId, repository: event.repo, number };
  const key = readyPullRequestKey(target, headSha, policy, await read(target));
  return key === undefined ? undefined : { key, readiness: { number, headSha } };
}
