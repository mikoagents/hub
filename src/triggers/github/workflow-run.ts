import { z } from "zod";
import type { NormalizedGitHubEvent } from "../../auth/github-events.js";

const PullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    head: z.object({ sha: z.string() }).passthrough().optional(),
  })
  .passthrough();

const WorkflowRunPayloadSchema = z
  .object({
    action: z.string(),
    sender: z.object({ login: z.string() }).passthrough().optional(),
    workflow_run: z
      .object({
        id: z.number().int().positive(),
        run_attempt: z.number().int().positive().default(1),
        event: z.string(),
        name: z.string().optional(),
        status: z.string(),
        conclusion: z.string().nullable(),
        head_sha: z.string().min(1),
        html_url: z.string().optional(),
        pull_requests: z.array(PullRequestSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

export function completedWorkflowRun(event: NormalizedGitHubEvent) {
  if (event.type !== "workflow_run") return undefined;
  const parsed = WorkflowRunPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const payload = parsed.data;
  if (
    payload.action !== "completed" ||
    payload.workflow_run.status !== "completed" ||
    payload.workflow_run.event !== "pull_request"
  )
    return undefined;
  return payload;
}

/** A logical event survives GitHub redelivery; a new CI attempt remains distinct. */
export function githubEventKey(event: NormalizedGitHubEvent): string {
  const workflow = completedWorkflowRun(event)?.workflow_run;
  if (workflow !== undefined) {
    return JSON.stringify([event.repositoryId, "workflow_run", workflow.id, workflow.run_attempt]);
  }
  const review = event.payload["review"];
  if (
    event.type === "pull_request_review" &&
    typeof review === "object" &&
    review !== null &&
    "id" in review &&
    typeof review.id === "number"
  ) {
    return JSON.stringify([event.repositoryId, event.type, review.id, event.payload["action"]]);
  }
  return event.id;
}
