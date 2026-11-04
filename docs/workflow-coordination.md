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
