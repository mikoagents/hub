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

PR review triggers can set `filters: { from_users: ['*'], draft: false }` on their
created, synchronized and ready events. Draft events are then rejected before a run,
agent or reaction is created; missing draft metadata also fails that filter. Omit
`draft` to keep accepting both states, or use `draft: true` for draft-specific work.
Older already-accepted draft runs remove their progress reaction when they finish
without adding a completion thumbs-up. A skipped draft does not establish a completed review.

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
      repair_limit:
        from_user: "repairer[bot]"
        max_consecutive_commits: 3
```

Without `completion_label`, the policy is read-only and grants no agent authority. It requires an open, non-draft,
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
The optional `repair_limit` bounds consecutive commits authored by the configured GitHub
account (1–20). The installation reads the exact head's first-parent chain, stopping at a
different attributed author or the limit. A human-authored commit resets the count; a base
update, review, CI rerun or trigger revision does not. This counts all commits by that account,
not just commits carrying a workflow-specific trailer. An unlinked author cannot establish
a reset and prevents repair dispatch until attribution is available. Read errors propagate.
Hub checks the limit both at intake and immediately before model dispatch, without creating
an execution or spending an execution meter unit when the limit is reached. Completion
label reconciliation remains independent: exhausting the repair budget never turns findings
into a pass. Omit the setting to retain unbounded commit rounds. It is a commit-chain limit,
not a cost cap or a limit on distinct failed attempts without commits.

This gate does not watch external checks/statuses independently. It consumes GitHub API
requests; it does not consume model tokens while waiting.

`github-readiness.integration.test.ts` covers pending and clean PRs, cross-source duplicates,
restart, genuinely new evidence, meter usage and stale queued work using real storage.
`pull-request-reader.integration.test.ts` exercises the production Octokit transport against
a local GitHub API boundary, including pagination, bot identity and read failures. The
same reader has also been checked read-only against a real GitHub PR; it does not prove a
live coding-agent repair and push.

## Completion labels without an agent

The readiness policy can explicitly authorize one completion label on the event's PR:

```yaml
github_pull_request:
  review: { from_user: "reviewer[bot]", body_contains: "<!-- review-protocol:2 -->" }
  feedback_from: ["reviewer[bot]", "codex[bot]"]
  required_workflows: ["Coverage", "Repository Checks"]
  completion_label:
    name: ai-complete
    color: "0E8A16"
    description: "AI review and repairs complete; human approval remains separate"
    review_body_contains: "<!-- technical-review:pass -->"
    exclusive_with: ["ai-failed", "ai-incomplete"]
```

The additional text must positively identify a completed, clean technical review; an
incomplete review or merely waiting for a maintainer decision is insufficient. Hub also
requires all inline discussions resolved, mandatory and known workflows completed without
failure, at least one successful/nonblocking check, and no pending/failed checks or commit
statuses. Missing evidence and API failures never imply completion. External check/status
reads happen only when completion labeling is enabled. Oversized results fail closed.

Review summaries may be followed by a default-closed HTML `details` block for supporting
evidence. Completion text and textual `CHANGES REQUESTED` / `REVIEW INCOMPLETE` verdicts
are read from the summary before the first `details` block. Historical verdicts quoted
inside that record do not start another repair or change the current completion result.

Subscribe the same trigger to `github.pull_request_synchronized` to invalidate old completion
before the new head has a review. Review and workflow completion events reconcile the label
regardless of arrival order. No workflow run or coding model is created for clean input.
The configured field explicitly grants label-definition creation and association/removal
authority, using the event's GitHub installation; the App needs Issues or Pull requests write.
Only labels explicitly listed in `exclusive_with` are cleared when completion is applied;
all other labels and human approvals remain independent. The completion setting does not alter
the repair deduplication key, and it is absent by default.

Writes recheck head and read back the resulting state; stale-head events leave a newer
head's labels alone. GitHub does not offer conditional label writes, so concurrent changes
can temporarily leave stale metadata until readback or the next event. There is no polling
loop: only subscribed events reconcile changes, including a newly completed failing CI
attempt or newly submitted review. Reopening a discussion or an external status change
alone requires a later subscribed event to reconcile.
