# Activity details

Select an organization Activity row to inspect its prompt, status, timestamps, step outputs,
failure reasons, and event context without leaving the list. Members can read activity for their
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

Capture starts when this version of Hub observes an event. It cannot reconstruct logs for older
runs or events missed while disconnected: the execution protocol has no transcript backfill
operation. Recovery snapshots are excluded because they may describe a previous conversation
turn. Empty logs are identified explicitly. A log write failure is reported through Hub's normal
diagnostics and does not prevent execution completion.
