# Workflow event coordination

CI follow-ups use `github.workflow_run_completed`. The GitHub App must subscribe to
**Workflow run** and have **Actions: read** and **Pull requests: read**. Only completed
workflows whose original event was `pull_request` match the semantic event, including
failed, cancelled and successful conclusions. The agent decides what requires repair.

The event context contains `github.workflow_run.id`, `run_attempt`, `head_sha`,
`conclusion`, and optional `name` and `html_url`. It also contains the associated PR in
`github.item`. A missing or ambiguous association is resolved through GitHub's commit-to-PR
API; it must resolve to exactly one open PR at that head in the source repository.
Otherwise the event is dropped. API errors remain failures so the delivery can be retried.

Coordination is explicit and otherwise absent:

```yaml
run:
  coordination:
    serialize: conversation
    deduplicate: event
```

`serialize` queues runs of one organization trigger by the provider's conversation key.
For GitHub this is the repository ID and issue or PR number. It applies to the entire
workflow, including multiple steps. Different PRs run independently. A source without a
conversation is rejected rather than silently running concurrently. Queue time counts
toward the authored whole-run deadline.

`deduplicate` reuses the accepted run for a logical event within that trigger. GitHub CI
uses repository ID, workflow run ID and attempt; a rerun can therefore start new work.
Reviews use repository ID, review ID and action. Other providers use their delivery ID.
Deduplication lasts while the run is retained, including after failure; deliberate retries
need a new event or CI attempt. Trigger configuration revisions do not erase the claim.

Both keys are persisted on `trigger_runs`. A unique index claims logical events at intake;
execution creation holds a transaction-scoped group lock and checks persisted predecessors
and active executions before dispatching. Busy runs retain a wakeup instead of creating an
execution or consuming an execution meter unit. Restart recovery uses the same stored keys,
wakeups and execution ownership. Terminal states release the group after pending daemon
interrupt/archive actions have completed; a provider's
session continuation policy does not provide this exclusion.

Validation: `src/db/workflow-coordination.integration.test.ts` exercises real embedded
and PostgreSQL databases, migrations, retries, queue release and restart recovery.
`src/workflows/coordination.integration.test.ts` covers event matching through persisted
workflow dispatch and independent PRs; the external Paseo execution transport is represented
at its boundary. `src/triggers/github/ci-completion.test.ts` covers event eligibility and
logical attempt identity. These tests do not prove a live GitHub-to-coding-agent repair.

## Avoiding unnecessary agent executions

Event deduplication alone cannot combine independent workflow completions and review
notifications. Opt in to a deterministic GitHub readiness gate and state deduplication:

```yaml
run:
  coordination:
    serialize: conversation
    deduplicate: provider_state
    github_pull_request:
      review:
        from_user: reviewer[bot]
        body_contains: "<!-- review-protocol:2 -->"
      feedback_from: ["reviewer[bot]", "codex[bot]"]
      required_workflows: ["Coverage", "Repository Checks"]
```

The policy is read-only and grants no agent authority. It requires an open, non-draft,
same-repository PR at the event's exact head, and a submitted current-head review by the
configured reviewer containing the configured text. Every named mandatory workflow must
exist, and every currently known PR workflow at that head must be completed. Conditional
workflows can remain absent; name only workflows that always run for the selected PRs.
A missing review/workflow or pending CI drops the event without creating an execution.
A later review or workflow completion can pass the gate; there is no model polling loop.

An agent starts only when there is a failed workflow, an unresolved thread by one of the
configured feedback authors, or a current-head review from those authors with
`CHANGES_REQUESTED` state or `CHANGES REQUESTED` in its body. Clean approval and unrelated
successful CI notifications need no agent. This is a routing hint, not a replacement for
the agent verifying findings, logs and repository-specific required checks.

The persisted state identity combines repository/PR, head/base, policy, trusted review and
thread content, and failed workflow attempts. It is shared across review and CI sources
and survives restart and configuration revisions. Resolving a thread and completing an
unrelated successful workflow do not introduce new evidence. New findings or a new failed
CI attempt can start another repair, including on the same head. A failed accepted run
also retains its claim, preventing automatic failure/retry loops for identical input.
Changing the policy deliberately changes the input identity.

Before dispatch, Hub waits for the existing conversation owner, then rechecks whether the
PR is still open, non-draft and on the accepted head. An obsolete queued step is skipped
before an execution or meter unit is created. The database exclusion at execution creation
remains authoritative; the earlier queue check avoids repeated GitHub reads while busy.
Read failures propagate for durable retry and never fall back to a model. Review and thread
pagination is bounded at 1,000 entries; Actions search truncation at 1,000 fails closed.
This gate does not watch external checks/statuses independently or impose a repair-round
budget. It consumes GitHub API requests; it does not consume model tokens while waiting.

`github-readiness.integration.test.ts` covers pending and clean PRs, cross-source duplicates,
restart, genuinely new evidence, meter usage and stale queued work using real storage.
`pull-request-reader.integration.test.ts` exercises the production Octokit transport against
a local GitHub API boundary, including pagination, bot identity and read failures. The
same reader has also been checked read-only against a real GitHub PR; it does not prove a
live coding-agent repair and push.
