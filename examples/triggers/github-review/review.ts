import type { TriggerContext, TriggerEvent } from "@getpaseo/hub/triggers";
import { policy } from "./policy.js";

interface PullRequest {
  number: number;
  state: string;
  draft?: boolean | undefined;
  user: { login: string };
  head: { sha: string };
  base: { sha: string };
  labels?: { name: string }[];
}
interface ReviewReceipt {
  review_id: number;
  commit_sha: string;
  url: string;
  inline_comments: number;
}
const path = `/repos/${policy.repository}`;
const receiptSchema = {
  type: "object",
  properties: {
    review_id: { type: "integer", minimum: 1 },
    commit_sha: { type: "string" },
    url: { type: "string" },
    inline_comments: { type: "integer", minimum: 0 },
  },
  required: ["review_id", "commit_sha", "url", "inline_comments"],
  additionalProperties: false,
};

/** The entire review/fix policy is ordinary application code, outside Hub's trigger engine. */
export async function reviewPullRequest(ctx: TriggerContext) {
  const number = await pullRequestNumber(ctx);
  return ctx.withLock("pull-request", `pr:${policy.repository}:${number}`, async () => {
    let previousHead: string | null = null;
    for (let round = 0; round <= policy.maxFixRounds; round++) {
      const pull = await readPull(ctx, `${round}:pull`, number);
      eligible(ctx, pull);
      const head = pull.head.sha;
      if (round === 0 && eventHead(ctx.event) !== null && eventHead(ctx.event) !== head)
        ctx.skip("The event describes a stale PR head");
      if (head === previousHead) throw new Error("Repair did not push a new PR head");
      if (!(await ctx.claim(`review:${policy.version}:${number}:${head}:${pull.base.sha}`)))
        ctx.skip("This PR head and review policy already have a durable owner");
      if (pull.labels?.some((label) => label.name === policy.completeLabel))
        await ctx.github.request(`${round}:clear-label`, "review", {
          method: "DELETE",
          path: `${path}/issues/${number}/labels/${encodeURIComponent(policy.completeLabel)}`,
        });
      const failedCi = await waitForCi(ctx, number, head, `${round}:ci`);
      if (failedCi.length > 0) {
        if (round === policy.maxFixRounds)
          throw new Error("Configured CI repair round limit reached");
        await enforceCommitLimit(ctx, head, `${round}:ci-budget`);
        await ctx.agent.run(`${round}:ci-repair`, {
          target: "repository",
          agent: policy.agent,
          github: "repair",
          maxRuntime: "50m",
          idleTimeout: "10m",
          worktree: { mode: "checkout-pr", prNumber: number },
          prompt: `Repair failing CI on ${policy.repository} PR #${number} at ${head}: ${failedCi.join(", ")}. Verify the accepted head before editing. Run the failed checks, push the justified fix, and call finish_execution. Report failures with finish_execution({error: reason}). Independent review will run on the new head.`,
        });
        previousHead = head;
        continue;
      }
      let receipt = await review(ctx, number, head, `${round}:review`);
      let published = await verifyReceipt(ctx, number, head, receipt, `${round}:receipt`);
      for (let verification = 0; published.body.includes(policy.incompleteMarker); verification++) {
        if (verification >= policy.maxVerificationRounds)
          throw new Error("Validation remains incomplete after the configured verification rounds");
        const failures = await waitForCi(
          ctx,
          number,
          head,
          `${round}:verification:${verification}:ci`,
        );
        if (failures.length > 0)
          throw new Error(
            "Supplemental verification CI failed; a new repair candidate is required",
          );
        const result = await ctx.agent.run<ReviewReceipt>(`${round}:verification:${verification}`, {
          target: "repository",
          agent: policy.agent,
          github: "review",
          maxRuntime: "50m",
          idleTimeout: "10m",
          worktree: {
            mode: "branch-off",
            newBranch: "verify-${{ paseo.execution.id }}",
            base: head,
          },
          output: { schema: receiptSchema },
          prompt: `Complete missing validation for ${policy.repository} PR #${number} at ${head}. Previous incomplete Review: ${receipt.url}. Check actual CI evidence and run missing checks. Publish a formal replacement Review through the authorized GitHub tools only when evidence supports it. Preserve REVIEW INCOMPLETE if validation is unfinished. Return the actual published Review receipt using finish_execution. Report tool or verification failure with finish_execution({error: reason}); a prose conclusion is insufficient.`,
        });
        receipt = result.output;
        published = await verifyReceipt(
          ctx,
          number,
          head,
          receipt,
          `${round}:verified:${verification}`,
        );
      }
      const current = await readPull(ctx, `${round}:after-review`, number);
      if (current.head.sha !== head || current.base.sha !== pull.base.sha)
        ctx.skip("PR changed while the review was running; the new event owns the new candidate");
      if (receipt.inline_comments === 0 && published.state !== "CHANGES_REQUESTED") {
        await ctx.state.set(`${round}:save`, `result:${number}`, {
          head,
          base: pull.base.sha,
          review: receipt.url,
        });
        await ctx.github.request(`${round}:complete-label`, "review", {
          method: "POST",
          path: `${path}/issues/${number}/labels`,
          body: { labels: [policy.completeLabel] },
        });
        await ctx.log("Review completed", { head, review: receipt.url });
        return { head, review: receipt.url };
      }
      if (round === policy.maxFixRounds) throw new Error("Configured repair round limit reached");
      await enforceCommitLimit(ctx, head, `${round}:repair-budget`);
      await ctx.agent.run(`${round}:repair`, {
        target: "repository",
        agent: policy.agent,
        github: "repair",
        maxRuntime: "50m",
        idleTimeout: "10m",
        worktree: { mode: "checkout-pr", prNumber: number },
        prompt: `Address the formal Review ${receipt.url} on ${policy.repository} PR #${number}. Before editing, verify the PR is open, non-draft and its head is ${head}; stop if it changed. Fix justified findings, run relevant checks and push the fix to the PR branch. Do not approve your own fix. Call finish_execution after the push, or finish_execution({error: reason}) when blocked or unsuccessful.`,
      });
      previousHead = head;
    }
    throw new Error("Repair flow exhausted");
  });
}

async function pullRequestNumber(ctx: TriggerContext): Promise<number> {
  const raw = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const pull = raw["pull_request"] as { number?: number } | undefined;
  const issue = raw["issue"] as { number?: number; pull_request?: unknown } | undefined;
  const manual = raw["pr"];
  const workflow = raw["workflow_run"] as
    | { pull_requests?: { number: number }[]; head_branch?: string }
    | undefined;
  const number =
    pull?.number ??
    (issue?.pull_request === undefined ? undefined : issue.number) ??
    (typeof manual === "number" ? manual : undefined) ??
    workflow?.pull_requests?.[0]?.number;
  if (number !== undefined) return number;
  if (workflow?.head_branch) {
    const candidates = await ctx.github.request<PullRequest[]>("resolve-workflow-pr", "review", {
      method: "GET",
      path: `${path}/pulls?state=open&head=${encodeURIComponent(`${policy.repository.split("/")[0]}:${workflow.head_branch}`)}`,
    });
    if (candidates.length === 1) return candidates[0]!.number;
  }
  ctx.skip("The event does not identify exactly one pull request");
}
function eligible(ctx: TriggerContext, pull: PullRequest) {
  if (pull.state !== "open" || pull.draft) ctx.skip("PR is closed or draft");
  if (!policy.trustedAuthors.includes(pull.user.login))
    ctx.skip("PR author is outside the explicitly configured trusted set");
}
function eventHead(event: TriggerEvent): string | null {
  const raw = (event.payload ?? {}) as Record<string, unknown>;
  const pull = raw["pull_request"] as { head?: { sha?: string } } | undefined;
  const workflow = raw["workflow_run"] as { head_sha?: string } | undefined;
  const check = raw["check_suite"] as { head_sha?: string } | undefined;
  return pull?.head?.sha ?? workflow?.head_sha ?? check?.head_sha ?? null;
}
function readPull(ctx: TriggerContext, id: string, number: number) {
  return ctx.github.repo("review", policy.repository).pulls.get(id, number);
}

async function waitForCi(ctx: TriggerContext, number: number, head: string, id: string) {
  for (let attempt = 0; attempt < policy.maxCiEvents; attempt++) {
    const pull = await readPull(ctx, `${id}:${attempt}:pull`, number);
    eligible(ctx, pull);
    if (pull.head.sha !== head) ctx.skip("PR head changed while waiting for CI");
    const workflows = await ctx.github
      .repo("review", policy.repository)
      .actions.runs(`${id}:${attempt}:workflows`, { headSha: head }, { maxPages: policy.maxPages });
    const latest = [
      ...new Map(workflows.sort((a, b) => a.id - b.id).map((run) => [run.name, run])).values(),
    ];
    const settled =
      policy.requiredWorkflows.every((name) => latest.some((run) => run.name === name)) &&
      latest.every((run) => run.status === "completed" && run.conclusion !== null);
    if (settled) {
      return latest
        .filter((run) => !["success", "neutral", "skipped"].includes(run.conclusion!))
        .map((run) => run.name);
    }
    await ctx.waitForEvent(`${id}:${attempt}:wait`, {
      source: "github",
      event: ["workflow_run.completed", "check_suite.completed", "pull_request.*"],
      timeout: "2h",
      where: (event) => affects(event, number, head),
    });
  }
  throw new Error("CI event limit reached");
}
function affects(event: TriggerEvent, number: number, head: string): boolean {
  const raw = event.payload as Record<string, unknown>;
  return (
    (raw["pull_request"] as { number?: number } | undefined)?.number === number ||
    (raw["workflow_run"] as { head_sha?: string } | undefined)?.head_sha === head ||
    (raw["check_suite"] as { head_sha?: string } | undefined)?.head_sha === head
  );
}
async function review(
  ctx: TriggerContext,
  number: number,
  head: string,
  id: string,
): Promise<ReviewReceipt> {
  const result = await ctx.agent.run<ReviewReceipt>(id, {
    target: "repository",
    agent: policy.agent,
    github: "review",
    maxRuntime: "50m",
    idleTimeout: "10m",
    worktree: { mode: "branch-off", newBranch: "review-${{ paseo.execution.id }}", base: head },
    output: { schema: receiptSchema },
    prompt: `Review ${policy.repository} PR #${number} at commit ${head}. Verify the candidate, run relevant checks and publish an actual formal GitHub Review, including actionable inline findings. Include REVIEW INCOMPLETE if required verification is unfinished. Call finish_execution with the actual published review_id, commit_sha, url and inline_comments count under output. Report publishing or execution failures with finish_execution({error: reason}).`,
  });
  return result.output;
}
async function verifyReceipt(
  ctx: TriggerContext,
  number: number,
  head: string,
  receipt: ReviewReceipt,
  id: string,
) {
  const github = ctx.github.repo("review", policy.repository);
  const review = await github.pulls.review(id, number, receipt.review_id);
  if (
    !review.submitted_at ||
    review.state === "PENDING" ||
    review.commit_id !== head ||
    receipt.commit_sha !== head ||
    review.html_url !== receipt.url ||
    review.user?.login !== policy.botLogin
  )
    throw new Error(
      "Review receipt does not prove an authorized formal Review on the accepted head",
    );
  const comments = await github.pulls.reviewComments(`${id}:comments`, number, receipt.review_id, {
    maxPages: policy.maxPages,
  });
  if (comments.length !== receipt.inline_comments)
    throw new Error("Review receipt inline comment count is incorrect");
  return review;
}
async function enforceCommitLimit(ctx: TriggerContext, head: string, id: string) {
  let sha = head;
  for (let count = 0; count < policy.maxConsecutiveBotCommits; count++) {
    const commit = await ctx.github.request<{
      author: { login: string } | null;
      parents: { sha: string }[];
    }>(`${id}:${count}`, "review", { method: "GET", path: `${path}/commits/${sha}` });
    if (!commit.author) throw new Error("Cannot establish commit author attribution");
    if (commit.author.login !== policy.botLogin) return;
    const parent = commit.parents[0];
    if (!parent) break;
    sha = parent.sha;
  }
  throw new Error("Consecutive bot commit limit reached");
}
