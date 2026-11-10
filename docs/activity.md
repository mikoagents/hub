# Activity details

Code Triggers appear in the same Activity list and in each Trigger's Run history. Run details lead
with the final result; expand a step to inspect its operation ID, input and output. The original
event is available in its own collapsed section. Diagnostics show runner logs. Conversation selects the actual child
agent session. Queued and durable waiting runs are active states. Historical YAML runs remain
linked to their owning Trigger; child agent operations appear within their parent code run.
The Trigger's own history opens on Run details, with its result and steps available first.

Select an organization Activity row to inspect its prompt, status, timestamps, step outputs,
failure reasons, and event context without leaving the list. The dialog opens on Conversation; Run details contains the prompt,
step outputs and event context, while Diagnostics contains session metadata, CLI commands and raw
runtime events. Long messages expand in place, and multi-step runs select one conversation at a
time. The title and view controls remain visible while the content scrolls. Members can read activity for their
organization; each detail and log request validates both the trigger and the run. Migrated runs
remain accessible through the trigger that originally owned them.

The list shows a failed run's reason beneath its status. Agents must report unsuccessful work with
`finish_execution.error`; that records a failed run instead of a successful completion reaction.
A failure described only in the agent's final prose does not change a successful completion callback.

Hub records observed agent stream and lifecycle events in `agent_execution_logs`, associated with
the individual execution. Logs survive completion and Hub restarts. The dialog reads 100 entries
at a time in receipt order and refreshes active executions every five seconds. Authentication
fields and known Hub execution and session tokens are redacted before storage. Logs are deleted
with their execution; there is no separate automatic retention period.

Runtime event capture starts when Hub observes an event. Events missed while disconnected or
before capture was enabled are absent from this event log. Session history, described below,
can recover conversation messages without reconstructing every runtime event. Recovery snapshots
are excluded from the event log because they may describe a previous conversation turn. Empty logs are identified explicitly. A log write failure is reported through Hub's normal
diagnostics and does not prevent execution completion.

## Session history

Each started step also opens the associated session conversation. User and assistant messages
are readable in order; reasoning and tool calls expand to show commands, inputs, output, errors
and original details. Session diagnostics include provider, model, working directory, native
agent and provider session references, plus copyable `miko agent inspect` and `miko agent logs`
commands. A continued session includes previous executions' conversation history.

Hub reads bounded canonical pages through Miko execution protocol 2.1.0, saves a redacted copy
and uses epoch/sequence cursors to retrieve missed rows after reconnect. Older messages load
on demand; initial and incremental synchronization is bounded to three pages per refresh.
Opening Activity and runtime recovery/turn completion refresh the cache. If the daemon is
offline, Activity explicitly shows the last saved copy; messages not yet synchronized are not
claimed as complete. A provider history reset replaces the old cached epoch instead of mixing
incompatible histories. Session copies are removed with their Hub session.

Runtime events remain separately available for lifecycle and permission diagnostics. These
observed events do not backfill, while the session conversation can now be retrieved from Miko
when provider history remains available. Native provider output limits apply to both paths.

If the provider no longer retains a stopped session, history reads report it as unavailable
rather than creating an empty replacement session. Hub keeps any previously saved conversation.
