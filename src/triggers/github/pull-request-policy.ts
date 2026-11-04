import { z } from "zod";

/** Read-only, deterministic readiness policy. It never grants execution authority. */
export const GitHubPullRequestPolicySchema = z
  .object({
    review: z
      .object({
        from_user: z.string().min(1),
        body_contains: z.string().min(1),
      })
      .strict(),
    feedback_from: z.array(z.string().min(1)).min(1),
    required_workflows: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type GitHubPullRequestPolicy = z.infer<typeof GitHubPullRequestPolicySchema>;
