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
  // Only completion labeling requires external checks and commit statuses.
  checks?: { status: string; conclusion: string | null }[];
  statuses?: { state: string }[];
}

export interface PullRequestTarget {
  installationId: number;
  repository: string;
  number: number;
  includeChecks?: boolean;
}
export type ReadPullRequest = (target: PullRequestTarget) => Promise<PullRequestSnapshot>;
export type SyncCompletionLabel = (
  target: PullRequestTarget,
  headSha: string,
  label: NonNullable<GitHubPullRequestPolicy["completion_label"]>,
  complete: boolean,
) => Promise<void>;

export function pullRequestComplete(
  snapshot: PullRequestSnapshot,
  policy: GitHubPullRequestPolicy,
): boolean {
  const label = policy.completion_label;
  if (label === undefined || !currentPullRequest(snapshot, snapshot.headSha)) return false;
  const review = snapshot.reviews
    .filter(
      (item) =>
        item.author === policy.review.from_user &&
        item.headSha === snapshot.headSha &&
        !["PENDING", "DISMISSED"].includes(item.state),
    )
    .sort((a, b) => b.id - a.id)[0];
  if (
    review === undefined ||
    !review.body.includes(policy.review.body_contains) ||
    !review.body.includes(label.review_body_contains) ||
    review.body.includes("REVIEW INCOMPLETE")
  )
    return false;
  if (snapshot.threads.some((thread) => !thread.resolved)) return false;
  if (
    readyPullRequestKey({ repository: "", number: 0 }, snapshot.headSha, policy, snapshot) !==
    undefined
  )
    return false;
  const latest = latestWorkflows(snapshot, snapshot.headSha);
  return (
    policy.required_workflows.every((name) => latest.some((run) => run.name === name)) &&
    latest.every(
      (run) =>
        run.status === "completed" &&
        ["success", "neutral", "skipped"].includes(run.conclusion ?? ""),
    ) &&
    snapshot.checks !== undefined &&
    snapshot.checks.length > 0 &&
    snapshot.checks.every(
      (check) =>
        check.status === "completed" &&
        ["success", "neutral", "skipped"].includes(check.conclusion ?? ""),
    ) &&
    snapshot.statuses !== undefined &&
    snapshot.statuses.every((status) => status.state === "success")
  );
}

function latestWorkflows(snapshot: PullRequestSnapshot, head: string) {
  const latest = new Map<number, PullRequestSnapshot["workflows"][number]>();
  for (const run of snapshot.workflows) {
    if (run.headSha !== head) continue;
    const previous = latest.get(run.workflowId);
    if (
      previous === undefined ||
      run.id > previous.id ||
      (run.id === previous.id && run.attempt > previous.attempt)
    )
      latest.set(run.workflowId, run);
  }
  return [...latest.values()];
}

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

  const workflows = latestWorkflows(snapshot, expectedHead);
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
    policy: {
      review: policy.review,
      feedback_from: policy.feedback_from,
      required_workflows: policy.required_workflows,
    },
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
  syncLabel?: SyncCompletionLabel,
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
  const snapshot = await read({
    ...target,
    ...(policy.completion_label === undefined ? {} : { includeChecks: true }),
  });
  if (!currentPullRequest(snapshot, headSha)) return undefined;
  if (policy.completion_label !== undefined) {
    if (syncLabel === undefined) throw new Error("GitHub completion label writer unavailable");
    await syncLabel(
      target,
      headSha,
      policy.completion_label,
      pullRequestComplete(snapshot, policy),
    );
  }
  const key = readyPullRequestKey(target, headSha, policy, snapshot);
  return key === undefined ? undefined : { key, readiness: { number, headSha } };
}
