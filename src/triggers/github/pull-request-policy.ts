import { z } from "zod";

/** Deterministic readiness; optional label authority is explicit and never starts a model. */
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
    repair_limit: z
      .object({
        from_user: z.string().min(1),
        max_consecutive_commits: z.number().int().min(1).max(20),
      })
      .strict()
      .optional(),
    completion_label: z
      .object({
        name: z.string().min(1).max(50),
        color: z.string().regex(/^[a-fA-F0-9]{6}$/u),
        description: z.string().max(100),
        review_body_contains: z.string().min(1),
        exclusive_with: z.array(z.string().min(1).max(50)).max(10).optional(),
      })
      .strict()
      .refine(
        (label) => !label.exclusive_with?.includes(label.name),
        "Completion label cannot exclude itself",
      )
      .optional(),
  })
  .strict();

export type GitHubPullRequestPolicy = z.infer<typeof GitHubPullRequestPolicySchema>;
