# Miko execution boundary

Hub owns trigger routing, workflow state, step authority, required outputs, structured results and
`finish_execution`. Miko owns execution connections, native runtime references and provider process
lifecycle. Provider options and permission modes keep their native semantics.

The daemon lives in [mikoagents/miko-daemon](https://github.com/mikoagents/miko-daemon), derived from
Paseo with its Git history and CLI → supervisor → worker → bootstrap architecture. Local execution
calls the inherited agent/session manager directly. Its distribution excludes the mobile/desktop/web
applications, speech, relay, full plugin host, browser/terminal UI, resident scheduler and script proxy.
The CLI exposes daemon, provider and Hub management. Execution uses the selected daemon's own
provider/session manager; Miko does not forward work to existing Paseo services. Native provider
permissions remain explicit.

## Public contract

The public execution protocol is `@mikoagents/execution-protocol`, independent of Paseo's native
protocol. `miko-compatibility.json` records the accepted daemon commit, exact protocol version and
schema digest. Hub vendors that canonical schema in `src/miko/protocol.ts`; runtime installation
has no sibling-checkout dependency. `npm run check:miko-protocol` detects drift. Source acceptance
also verifies the daemon's clean, exact commit and compares the schema byte-for-byte.

A socket must offer `x-miko-execution-protocol: 2.1.0`, then complete `miko.hello`/`miko.ready` with
matching enrolled permissions. Native session frames and other versions are rejected. Enrollment
credentials establish a connection; `hub.execute` separately grants execution.

The schema defines provider catalogs and validation, create/get/submit, watch/unwatch,
restore/cancel/cleanup, and durable receipt queries. Native RPC names do not cross this boundary.
A session persists Miko identity, provider, public session/workspace references and the
native agent reference. Every execution links that session. Continuation compatibility includes
Miko and provider, and each resumed snapshot must match the persisted native binding.
Provider catalogs advertise exact MCP preapproval capabilities; Hub has no provider-name allowlist.

Rendered task prompts pass unchanged through this boundary, including continuation. Session MCP
schemas enumerate the execution IDs the session may act on. The completion service still checks
live execution ownership, required output delivery and structured result validation on every call.

Creates, submissions and controls use stable semantic keys. Miko writes a private receipt before
the native request and replays confirmed results. Hub queries a submission's original receipt
before retrying. A pending result after a crash remains unknown and is never submitted again.
Watches subscribe before returning an authoritative snapshot. A daemon disconnection closes the Hub
channel so recovery reconnects to that daemon and resubscribes.

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

Enroll Miko using `miko hub login <hub-origin>`, grant `hub.execute` when intended, and select the
daemon and its provider in workflow configuration. Validate a workflow and its outputs before
resuming intake. Existing instances must perform this cutover themselves; source tests use
isolated databases and daemons.

## Local provider cutover

Protocol 2.0.0 removes execution backends and existing-Paseo service forwarding. Remove
`backend` from authored agents before redeploying; it is rejected rather than ignored.
Migration `0053_remove_execution_backends` refuses active work, releases old continuation keys
and removes retired selectors from historical session data. Existing remote sessions are not
converted to local ones. Upgrade Hub and Miko together and start fresh sessions after draining.

## Diagnostic history

Protocol 2.1.0 adds owned-session timeline reads with bounded pages, epoch/sequence cursors and
native/provider session metadata. Hub caches redacted canonical rows and presents the session
in Activity; Miko supplies authoritative available history through its existing session manager.
Upgrade both sides together for the exact protocol handshake. Native CLI inspection follows
Paseo's `agent ls`, `agent inspect`, and `agent logs` commands.
