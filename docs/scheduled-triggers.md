# Scheduled Triggers

Schedules are declared in a [Trigger code project](programmable-triggers.md), alongside optional
manual, custom and provider entries. One Trigger can declare one recurrence:

```ts
import { defineTrigger } from "@mikoagents/hub/triggers";

export default defineTrigger({
  name: "daily-scan",
  runner: "local",
  on: [
    {
      source: "schedule",
      event: "tick",
      recurrence: {
        start: "2026-01-01T09:00:00",
        timezone: "Europe/Berlin",
        rule: "FREQ=DAILY;BYHOUR=9,17",
      },
    },
    { source: "manual", event: "run" },
  ],
  grants: {},
  limits: { maxRuntime: "30m" },
  async run(ctx) {
    return ctx.withLock("scan", "daily-scan", async () => {
      await ctx.log("Scan started", ctx.event.payload);
      // Declare explicit target grants and agent options here when a scan needs an agent.
      return { scheduledAt: ctx.event.receivedAt };
    });
  },
});
```

`start` is a local wall-clock date/time without an offset. `timezone` must be an IANA timezone;
`rule` is one supported RFC 5545 RRULE. The existing recurrence validator supports intervals,
BYDAY/BYHOUR/BYMINUTE and the other supported calendar selectors, with finite COUNT or UNTIL.
Invalid combinations and timezone names are rejected during `trigger check` and deployment.
COUNT is bounded to 1–10,000; use COUNT or UNTIL, never both. DST follows the existing recurrence
evaluator's wall-clock handling. A schedule subscription must match `tick`.

Hub's clock durably creates the run and advances its cursor in **one transaction**. After downtime,
one missed occurrence is coalesced into a catch-up run and the next occurrence moves beyond the
current time. An exhausted finite rule remains exhausted across restarts. Editing code without
changing the recurrence preserves its cursor. Changing the recurrence establishes a new cursor
using the Trigger's creation time; it can therefore produce a catch-up occurrence.

Code runs are independently durable; overlapping runs are allowed. Declare `ctx.withLock` when
only one scan should proceed at a time, or use a claim and skip policy for other overlap behavior.
The Trigger's `limits.maxRuntime` begins at intake and includes time spent queued or waiting.
Disabling a Trigger stops future scheduled intake without canceling accepted work. Re-enabling
can coalesce a missed occurrence. Cancel accepted runs explicitly when needed.

Schedule payloads are `{ scheduledAt, timezone }`; their envelope is
`{ source: "schedule", type: "tick", id: "schedule:<ISO time>", receivedAt, payload }`.
Manual payloads are exactly the submitted JSON. Code decides how to interpret the two entries;
there is no implicit prompt or context injection. Deploy with the ordinary Trigger CLI/API.
The existing historical YAML schedule store remains for already configured historical/project
workflows, with its own persisted history; rewriting to code preserves the Trigger identity.
