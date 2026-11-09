# Miko execution boundary

Hub owns trigger routing, workflow state, step authority, required outputs, structured results and
`finish_execution`. Miko owns execution connections, native runtime references and provider process
lifecycle. Provider options and permission modes keep their native semantics.

The daemon lives in [mikoagents/miko-daemon](https://github.com/mikoagents/miko-daemon), derived from
Paseo with its Git history and CLI → supervisor → worker → bootstrap architecture. Local execution
calls the inherited agent/session manager directly. Its distribution excludes the mobile/desktop/web
applications, speech, relay, full plugin host, browser/terminal UI, resident scheduler and script proxy.
The CLI exposes daemon, provider, backend and Hub management. A configured Paseo backend uses that service's
native protocol and credentials; the remote service owns its agents and workspaces. The adapter
never answers permission prompts or falls back to another backend.

## Public contract

The public execution protocol is `@mikoagents/execution-protocol`, independent of Paseo's native
protocol. `miko-compatibility.json` records the accepted daemon commit, exact protocol version and
schema digest. Hub vendors that canonical schema in `src/miko/protocol.ts`; runtime installation
has no sibling-checkout dependency. `npm run check:miko-protocol` detects drift. Source acceptance
also verifies the daemon's clean, exact commit and compares the schema byte-for-byte.

A socket must offer `x-miko-execution-protocol: 1.0.0`, then complete `miko.hello`/`miko.ready` with
matching enrolled permissions. Native session frames and other versions are rejected. Enrollment
credentials establish a connection; `hub.execute` separately grants execution.

The schema defines discovery, provider catalogs and validation, create/get/submit, watch/unwatch,
restore/cancel/cleanup, and durable receipt queries. Native RPC names do not cross this boundary.
A session persists Miko identity, backend, provider, public session/workspace references and the
native agent reference. Every execution links that session. Continuation compatibility includes
Miko, backend and provider, and each resumed snapshot must match the persisted native binding.
Provider catalogs advertise exact MCP preapproval capabilities; Hub has no provider-name allowlist.

Rendered task prompts pass unchanged through this boundary, including continuation. Session MCP
schemas enumerate the execution IDs the session may act on. The completion service still checks
live execution ownership, required output delivery and structured result validation on every call.

Creates, submissions and controls use stable semantic keys. Miko writes a private receipt before
the native request and replays confirmed results. Hub queries a submission's original receipt
before retrying. A pending result after a crash remains unknown and is never submitted again.
Watches subscribe before returning an authoritative snapshot. Backend disconnection closes the Hub
channel so recovery reopens the explicit backend and resubscribes.

## Updating the pair

Build and verify the daemon first, including affected inherited tests, `npm run test:miko`,
`npm run typecheck:miko`, packaging and clean installation. Commit it, then copy its canonical
protocol source into Hub and record its immutable commit and SHA-256 in `miko-compatibility.json`.
Update the same commit in Hub CI. Run `npm run check:miko-protocol` and the source E2E suites before
integrating Hub. The daemon's [maintenance guide](https://github.com/mikoagents/miko-daemon/blob/main/docs/miko-upstream.md)
owns selective upstream synchronization and its recorded baseline.

## Cutover

Pause intake and drain active workflows, or explicitly cancel them through the existing execution
lifecycle. Back up the database and configuration before upgrading. Migration
`0051_miko_execution_cutover` refuses active executions, revokes old registrations and
releases old continuation keys while retaining historical records. It does not transfer live work
or credentials to another protocol.

Enroll Miko using `miko hub login <hub-origin>`, grant `hub.execute` when intended, update target
configuration and select `run.agent.backend` (`local` when omitted). Validate a workflow and its
outputs before resuming intake. See the daemon's backend guide for native service credentials and
backend diagnostics. Existing instances must perform this cutover themselves; source tests use
isolated databases and daemons.
