import { defineTrigger } from "@getpaseo/hub/triggers";
import { policy } from "./policy.js";
import { reviewPullRequest } from "./review.js";

export default defineTrigger({
  name: "github-review",
  description: "Wait for CI, review, repair findings and independently review the new head.",
  diagram: `flowchart TD
    event([PR or CI event]) --> eligible{Eligible PR and new head?}
    eligible -->|No| skip[Skip]
    eligible -->|Yes| ci[Wait for CI]
    ci --> passed{CI passed?}
    passed -->|No| budget{Repair budget available?}
    budget -->|No| stop[Stop with reason]
    budget -->|Yes| fix[Repair and push new head]
    fix --> eligible
    passed -->|Yes| review[Publish and verify formal Review]
    review --> complete{Validation complete?}
    complete -->|No| verify[Wait for CI and supplement validation]
    verify --> review
    complete -->|Yes| findings{Unresolved findings?}
    findings -->|Yes| budget
    findings -->|No| done[Record result and add completion label]`,
  runner: policy.runner,
  on: [
    {
      source: "github",
      connection: policy.connection,
      resource: policy.repository,
      event: [
        "pull_request.*",
        "pull_request_review.*",
        "workflow_run.completed",
        "check_suite.completed",
      ],
    },
    { source: "manual", event: "run" },
  ],
  grants: {
    targets: {
      repository: { daemon: policy.daemon, cwd: policy.cwd, providers: [policy.agent.provider] },
    },
    github: {
      review: {
        connection: policy.connection,
        repositories: [policy.repository],
        permissions: {
          contents: "read",
          pull_requests: "write",
          issues: "write",
          actions: "read",
          checks: "read",
        },
      },
      repair: {
        connection: policy.connection,
        repositories: [policy.repository],
        permissions: {
          contents: "write",
          pull_requests: "write",
          issues: "write",
          actions: "read",
          checks: "read",
        },
      },
    },
  },
  limits: { maxRuntime: "12h", maxAgentRuns: 20 },
  run: reviewPullRequest,
});
