# Programmable Triggers

Triggers are TypeScript/JavaScript projects deployed as immutable bundles. The existing
**Triggers** page remains their management entry point. Each Trigger opens with a workflow diagram
and its recent runs. **Source code** always shows the file list; expand individual files or inspect an earlier revision.
The build's entry file appears first with an **Entrypoint** label when its path is recorded.
**Configuration** summarizes **The event**, **Where it runs**, **What runs there**, and
**GitHub access** in four rows. Expand a row to inspect its parameters and source links. You can enable or disable the Trigger and start its declared manual entry with
**Run now**.
**Activity** shows the durable operation journal, results, runner logs, and agent conversations.
Author code locally or in a Git repository and deploy from the CLI or CI.

Agent cards show the call sites in the deployed source, including parameters imported from local
constant configuration. They describe possible calls; conditions and loops determine which calls
execute. Values built from events, functions, mutable objects, or unsupported expressions are
marked **Computed at runtime**. Open **Prompt** to inspect a literal prompt or its construction
expression. **View code** opens the corresponding file and numbered excerpt in the current revision,
including when you were inspecting an older revision. The configuration cards always describe the
current deployment; the code and immutable bundle remain authoritative. Edit the project and deploy
again to change it.

Inspection reads source without importing or executing it. It is bounded and may report incomplete
analysis; this does not prevent viewing the source or run history. GitHub permissions and target
allowlists come from the validated deployment manifest, independently of the agent call summaries.

## Create and deploy

Use Node.js 22 or newer. The CLI is part of the built `@mikoagents/hub` package:

```sh
miko trigger init ./my-trigger
miko trigger check ./my-trigger/trigger.ts
miko trigger deploy ./my-trigger/trigger.ts \
  --url http://localhost:3000 --token-file /private/hub-credential
```

A credential needs `configuration:install` to deploy and enroll runners,
`configuration:validate` to validate/read source and activity, and `runs:dispatch` to run,
publish custom events, or cancel. Store credentials outside the source project.

The starter's Trigger name matches the directory name (`my-trigger` above). Use
`trigger init ./some-directory --name my-trigger` to choose a different identity. The starter
logs and returns the incoming input; it is ready to try with **Run now** once its `local` runner
is running. Deploying code builds and validates the bundle automatically. Use `trigger build
./my-trigger/trigger.ts --out ./trigger-artifact.json` and `trigger deploy --artifact
./trigger-artifact.json` when CI needs a separate build artifact.

```ts
import { defineTrigger } from "@mikoagents/hub/triggers";

export default defineTrigger({
  name: "health-check",
  runner: "local",
  on: [
    { source: "manual", event: "run" },
    { source: "monitor", event: "service.*" },
  ],
  grants: {},
  limits: { maxRuntime: "10m" },
  async run(ctx) {
    const statuses = await Promise.all(
      ["api", "web"].map((service) =>
        ctx.step(`check:${service}`, { service }, async ({ service }) => {
          const response = await fetch(`https://${service}.example.test/health`);
          return { service, healthy: response.ok };
        }),
      ),
    );
    await ctx.log("Checks finished", { statuses });
    return statuses;
  },
});
```

`name` identifies the organization Trigger. Redeploying that name adds a revision to the
same identity. Existing runs remain pinned to their original bundle. Renaming creates another
Trigger. Local imports and npm JavaScript dependencies are bundled by esbuild; install and lock
those dependencies in the author project. Use `--project-dir ./my-trigger` when an entry such
as `./my-trigger/src/trigger.ts` imports shared source above its own directory. Native addons,
runtime-loaded files, and external executables must be provisioned by the runner operator;
the bundle is not an operating-system image. The CLI retains project source, package manifests
the entry file path, and a SHA-256 digest covering the manifest, source, entry path, and executable code.

`check`/`build` evaluate the module's exported metadata in an author-side child process. Keep
module initialization free of effects. Hub validates the artifact and resource references without
importing the module. Artifact hashes detect content changes; they are not signatures proving
that an author is trusted.

## Start an independent runner

```sh
miko trigger runner-enroll local \
  --url http://localhost:3000 --token-file /private/hub-credential \
  --out /private/runner-credential
miko trigger runner \
  --url http://localhost:3000 --token-file /private/runner-credential \
  --directory /private/trigger-work --concurrency 1
```

Enrollment creates or rotates the organization's named runner credential. An existing output
file is refused before rotation. The credential can only lease work for that organization and
runner name; each worker receives an ephemeral credential for its own run. Stop the runner with
SIGTERM or Ctrl+C. An unfinished lease expires after 30 seconds and another runner can recover it.

Hub owns events, scheduling, persistence and Miko execution coordination. The runner owns code
execution. Each attempt has a separate subprocess and workspace, a 256 MiB Node heap limit,
and the run's absolute deadline. The worker receives a small environment allowlist rather than
inheriting Hub database, provider, or Miko configuration. Waiting for agents, timers, events or
locks releases the worker slot. The runner defaults to one concurrent worker; its configurable
range is 1–16.

**Runner code is trusted operator code.** A subprocess is not a security sandbox. Code and npm
packages can access the runner's operating-system account, filesystem and network. Use a dedicated
account/container/host and enforce network, CPU, memory and filesystem restrictions there when
needed. Hub validates grants for Hub-managed resources; it cannot constrain arbitrary direct
`fetch`, filesystem, or subprocess calls from trusted code.

To supply a secret explicitly, add its name to `grants.secrets`, put the value in a private JSON
object, start the runner with `--secrets-file /private/secrets.json`, and read `ctx.secret("NAME")`.
The worker receives only names granted by its pinned revision. Console and `ctx.log` strings,
including structured log strings, redact these values. Never return secrets from steps or put
them in source: operation inputs, results and code sources are durable organization data.

## Durable programming

- `ctx.step(id, input, action)` records an arbitrary local operation. Completed results are reused
  after restart. Put external I/O and nondeterministic values inside a step and return JSON data.
- `ctx.agent.run(id, options)` creates a child through the existing Miko protocol. Recovery
  reattaches to its durable execution identity. Provider names, models, modes, thinking options,
  and `agent.options` are preserved and checked by the selected daemon. Declare targets as
  `grants.targets.alias = { daemon, cwd, providers, env? }` and choose that alias explicitly.
- Agent `prompt` is literal text. No provider context, attachments, variables, prompt templates,
  or replies are added implicitly. Author the required text, output schema, allowed/required
  output capabilities, GitHub grant, worktree, continuation key, and timeouts explicitly.
- `ctx.sleep(id, milliseconds)` persists a timer. `ctx.waitForEvent(id, { source, event, timeout,
where? })` persists event subscriptions and cursors. `where` is ordinary JavaScript, evaluated
  during replay. Only subscribed sources can be awaited. Received events since the run started
  are retained, covering arrival before the waiter was registered. Use the predicate to correlate
  a repository, PR, commit or other business identity.
- `ctx.claim(key)` atomically claims a logical event across runs and revisions of the same Trigger.
  It remains claimed after termination. `ctx.withLock(id, key, action)` serializes code across
  runs; terminal cleanup releases locks. Change claim policy intentionally when permitting a
  previously handled candidate to run again.
- `ctx.state.get(id, key)`, `set(id, key, value)`, and `delete(id, key)` record accesses to
  Trigger-scoped state. Use new operation IDs for subsequent reads/writes. Keys starting with
  `__` are reserved for the coordinator.
- `ctx.github.request(id, grant, { method, path, body? })` uses an explicit repository/permission
  grant and a scoped installation token. Hub checks the repository path, refuses redirects,
  bounds the response, and revokes the token afterward. The credential never reaches source
  or logs. Granting GitHub authority to an agent uses the existing execution credential lifecycle.
- `ctx.skip(reason)` records a deliberate skipped run. Ordinary thrown errors fail a run.
  `ctx.log(message, data?)` and console messages appear in its Activity diagnostics.

IDs must be unique, stable strings within a run, including across loop iterations and parallel
branches. Inputs/results must be JSON data (no `undefined`, functions, dates or infinite numbers).
A replay that changes an operation's kind or input for the same ID fails visibly. Await every
started operation. Business branches and loops are re-executed on recovery; their durable results
provide deterministic decisions. Use `ctx.startedAt` for stable workflow time.

SDK results use the same normalized JSON representation on initial execution and recovery,
including nested object key order. Import `stableJson(value, space?)` when rendering JSON into
a prompt or another string. It validates JSON values and sorts object keys independently of
locale; arrays retain their order. Functions, dates, `undefined`, and non-finite numbers are
rejected. Operation input hashes remain a separate coordinator contract.

A local step or GitHub request interrupted after it started can have an **unknown external
outcome**. Hub records an explicit failed operation rather than repeating a possible write.
Code may catch that failure, reconcile the remote operation using its own idempotency key,
and issue an explicitly named new attempt. There is no automatic external-write retry or
exactly-once promise. Keep long-running work in durable agent or wait operations instead of
an ordinary local callback. Direct asynchronous work outside SDK operations has no recovery log.

`limits.maxRuntime` is an absolute run deadline; agent deadlines are capped by it.
`limits.maxAgentRuns` bounds agent operations. Cancellation and deadline expiry stop pending
children through the existing lifecycle. A successful agent still needs its authorized MCP
`finish_execution`, validated structured output and any required outputs; process exit or prose
alone does not complete the contract.

## Read GitHub data and publish comments

Bind a client to an explicitly granted connection alias and repository. These helpers use the
same installation-token lifecycle, repository checks and durable operation journal as
`ctx.github.request`. Endpoint result types come from GitHub's Octokit definitions.

```ts
import { githubIssueComment, stableJson } from "@mikoagents/hub/triggers";

const source = githubIssueComment(ctx.event);
if (source === null || source.action !== "created") ctx.skip("Not a new issue comment");
const github = ctx.github.repo("discussion", source.repository);
const issue = await github.issues.get("issue", source.number);
const comments = await github.comments.list("discussion", source.number, {
  maxPages: 5,
  maxItems: 500,
  retry: { maxAttempts: 3, maxDelayMs: 30_000 },
});
const prompt = stableJson({ request: source.body, issue, comments }, 2);
```

`githubIssueComment(event)` extracts the repository, Issue/PR number, comment id, body,
author, author type, action, and item kind from an issue-comment event. Other event kinds return
`null`; malformed matching events throw. It does not choose authorized users, mention spellings,
or whether bots should run. Make those decisions in your Trigger before reading private context
or dispatching an agent.

Repository clients expose `issues.get`, `comments.get/list/find/publishOnce`,
`pulls.get/files/reviews/review/comments/reviewComments`, `collaborators.permission`,
`commits.get`, `actions.runs`, `checks.list`, and `statuses.list`. Reads are independent:
request only the context your workflow needs. `actions.runs` accepts `{ headSha, event? }`;
checks and statuses take the explicit commit ref. No context is automatically added to prompts.

List helpers follow GitHub's `Link` header. Options default to `perPage: 100`, `maxPages: 10`,
and `maxItems: 1000`; exceeding either bound or receiving incomplete evidence throws rather
than returning a partial list. `ctx.github.paginate(id, grant, { path, itemsKey?, ...options })`
provides the same behavior for other repository endpoints. Use `itemsKey` for response objects
such as `workflow_runs` or `check_runs`. `ctx.github.response` returns `{ data, status, headers }`
when response metadata is needed; `request` continues to return the response body directly.

GET retries are opt-in through `{ retry: { maxAttempts, initialDelayMs?, maxDelayMs? } }`.
Attempts and delays are durable operations, so restarting a worker preserves the retry budget.
The SDK retries transport failures, server errors and rate limits. It respects `Retry-After`
or rate-limit reset time; a delay beyond `maxDelayMs` fails rather than retrying early.
The default initial delay is 1000 ms and maximum delay is 60000 ms. Writes reject automatic
retry options. IDs for the helper and its generated child operations must remain stable.

Catch `GitHubRequestError` to inspect `status`, `requestId`, `retryAfterMs`, and
`failure.{code,retryable,outcome}`. Metadata survives durable replay and error identity works
across a bundled Trigger and its runner. `outcome: "unknown"` means a write may have happened.
Error messages do not copy GitHub response bodies or authorization headers into the journal.

To publish one discussion reply per logical request, choose a stable HTML marker and expected
GitHub author explicitly. Check for a previous verified reply before starting expensive work:

```ts
const publication = {
  number: source.number,
  marker: `<!-- my-workflow:source-comment:${source.commentId} -->`,
  author: "my-app[bot]",
  maxPages: 5,
};
const previous = await github.comments.find("previous-reply", publication);
if (previous !== null) return previous;

// Recheck your workflow's source/permission/head conditions before publishing.
return github.comments.publishOnce("reply", {
  ...publication,
  body: "The agent's structured reply",
});
```

`publishOnce` serializes publication by repository, item and marker within the Trigger, appends
the marker, checks for an existing matching author, and reads the actual comment back to verify
its id, target, author, body and URL. A failed POST is reconciled by reading; it is never blindly
repeated. Multiple matching comments, a conflicting body, or an unconfirmed result fail visibly.
The receipt contains `{ repository, number, id, url, body, deduplicated }`. It does not promise
exactly-once behavior from GitHub or decide whether a source comment is still authorized;
permission and source/head rechecks remain explicit workflow policy.

## Show the workflow

Hub always shows a diagram based on the events declared in `on`: matching event → workflow
code → result and logs. Add an optional `diagram` string to explain your own conditions, branches,
or loops. Hub renders Mermaid syntax with [Pele](https://pele.run/examples#mindmap), including
flowcharts and mindmaps:

```ts
export default defineTrigger({
  name: "health-check",
  description: "Check the service and report whether it is healthy.",
  diagram: `flowchart LR
    event([Run now]) --> check[Check service]
    check --> healthy{Healthy?}
    healthy -->|Yes| ready[Return ready]
    healthy -->|No| blocked[Return blocked]`,
  on: [{ source: "manual", event: "run" }],
  runner: "local",
  grants: {},
  limits: { maxRuntime: "10m" },
  async run(ctx) {
    const healthy = await ctx.step("check", null, async () => {
      const response = await fetch("https://service.example/health");
      return response.ok;
    });
    return { status: healthy ? "ready" : "blocked" };
  },
});
```

For a branching overview, use a mindmap instead:

```ts
diagram: `mindmap
  root((Health check))
    When
      Run now
    Check service
      Healthy
        Return ready
      Unhealthy
        Return blocked`,
```

This diagram is author-written documentation, stored with the same code revision. Execution
follows `run(ctx)`; Hub does not guess the branches in arbitrary JavaScript. Update the diagram
when you change its logic. **Expand diagram** opens a larger, scrollable view. Invalid diagram
syntax leaves source, details and run history available.

The [GitHub review example](../examples/triggers/github-review/trigger.ts) includes a diagram
for CI checks, formal Review, supplemental verification, repairs and review of the new head.

## Events, schedules, and operations

Native GitHub/Slack/Discord/Linear events use their existing verified intake and named
organization connection. Declare raw event names, for example `source: "github"`,
`event: ["pull_request.*", "workflow_run.completed"]`, `connection: "github"`, and
`resource: "owner/repository"`. The event envelope contains `id`, `source`, `type`,
`receivedAt`, optional connection/resource and the verified JSON `payload`. Code performs
all filtering, branches, loops, API requests and candidate decisions.

Custom events use `trigger event <name> --input-file event.json`; the file contains
`{ "id": "unique-delivery", "source": "monitor", "type": "service.failed", "payload": {} }`.
This endpoint cannot impersonate native providers, manual entries or schedule ticks.
Repeated delivery IDs are deduplicated per source and Trigger. Custom envelopes may also carry
`connection` and `resource` metadata for declared custom subscriptions. Each matching incoming event
creates a run as well as becoming available to waiters; use early filtering and durable claims
to keep follow-up events inexpensive.

Schedules declare `{ source: "schedule", event: "tick", recurrence: { start, timezone, rule } }`.
See [scheduled Triggers](scheduled-triggers.md). A Trigger can combine one schedule with manual,
provider and custom entries. Disable stops new runs; event subscriptions held by accepted runs continue until those runs
finish or are canceled. Redeploying a different subscription likewise preserves the old run’s
connection/resource scope without starting new runs from a removed entry. Cancel those separately when desired.

The CLI includes `list`, `run`, `event`, `runs`, `logs`, `cancel`, `enable`, and `disable`.
Run a declared manual entry with `trigger run <name> --input-file input.json`; supply
`--delivery-key <key>` when retrying the same dispatch. Every remote command requires
`--url` and `--token-file`. Source/revision details use the existing `/api/v1/triggers` family:

| Method | Route                                   | Purpose                                   |
| ------ | --------------------------------------- | ----------------------------------------- |
| GET    | `/api/v1/triggers`                      | Lightweight deployment metadata           |
| POST   | `/api/v1/triggers/validate`, `/install` | `{ artifact }` validation/deployment      |
| GET    | `/{trigger}/revisions/{revision}`       | Immutable manifest, executable and source |
| POST   | `/{trigger}/run`, `/{trigger}/events`   | Manual/custom intake                      |
| POST   | `/{trigger}/enabled`                    | `{ enabled }`                             |
| GET    | `/{trigger}/runs`, `/runs/{run}`        | Runs, journal and recent logs             |
| POST   | `/runs/{run}/cancel`                    | Cancellation                              |
| POST   | `/runners`                              | Named runner enrollment/rotation          |

The API reference includes the runner lease/journal protocol. Runner credentials are separate
from organization API credentials. All worker mutations require the current run lease and are
fenced after lease expiry, reassignment, cancellation or terminal completion.

## Existing history and migration

Historical YAML revisions and their runs remain available. Deploy a rewritten code project with
the **same name** to retain the Trigger ID, runtime project, disabled/enabled state, revisions
and Activity history. This is an explicit rewrite: there is no automatic YAML-to-code conversion.
The new Trigger install API accepts code artifacts; the form/YAML editor is removed. Existing
project workflow machinery remains an internal execution and historical compatibility boundary.

Migrate and test against an independent Hub database first. Production rollout, active-run
handling, backups and any coordinated daemon change belong to an operator's separate cutover.

## GitHub review example

[`examples/triggers/github-review`](../examples/triggers/github-review) contains a multi-file
project with all business policy in code: trusted authors and draft/head gates, durable PR
locking and candidate claims, bounded CI waits and repairs, formal Review receipt validation,
supplemental validation, repair pushes, independent review on a new head, bot-commit and round
limits, and completion labels. Edit `policy.ts` and deploy; no Hub source change is required.
Its placeholders must be configured for your own repository, connection, bot and daemon.

Tests under `src/triggers/code/` use real subprocesses, PGlite/PostgreSQL, signed GitHub intake,
a controlled GitHub API and the native MCP completion lifecycle. The source E2E suite also
runs a built CLI/runner against the exact pinned source-built Miko daemon.
