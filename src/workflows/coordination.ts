import { z } from "zod";
import { GitHubPullRequestPolicySchema } from "../triggers/github/pull-request-policy.js";

/** Explicit run policy; provider events otherwise retain their existing parallel behavior. */
export const CoordinationSchema = z
  .object({
    serialize: z.literal("conversation").optional(),
    deduplicate: z.enum(["event", "provider_state"]).optional(),
    github_pull_request: GitHubPullRequestPolicySchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.serialize !== undefined || value.deduplicate !== undefined,
    "Coordination must enable serialization or deduplication",
  )
  .refine(
    (value) => value.github_pull_request === undefined || value.deduplicate === "provider_state",
    "GitHub pull request readiness requires provider_state deduplication",
  );

export type Coordination = z.infer<typeof CoordinationSchema>;
