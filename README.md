<p align="center">
  <img src="https://paseo.sh/logo.svg" width="64" height="64" alt="Miko Hub logo">
</p>

<h1 align="center">Miko Hub</h1>

<p align="center">Run coding agents from GitHub, Linear, Slack, and Discord on your own Miko daemons.</p>

<p align="center">
  <a href="https://paseo.sh/docs/hub">Docs</a> ·
  <a href="https://github.com/mikoagents/miko-daemon">Miko</a> ·
  <a href="LICENSE">Apache 2.0</a>
</p>

> [!WARNING]
> Miko Hub is in early development. Expect breaking changes and data loss. [Join the Miko Discord](https://discord.gg/jz8T2uahpH) to learn more about the project.

Miko Hub is the self-hosted automation layer for [Miko execution daemons](https://github.com/mikoagents/miko-daemon). Connect the services where work arrives and run agents on the machines where your development environments already live.

- **Your machines:** Hub dispatches to Miko daemons on your laptop, devbox, or build server, using each daemon's configured providers.
- **Your configuration:** Keep triggers, environments, permissions, and prompts in version control.
- **Your services:** Start agents from GitHub, Linear, Slack, Discord, or manual runs.
- **One audit trail:** See every event, configuration revision, execution, and result.

```text
 GitHub ─┐                 ┌─ laptop
 Linear ─┼─ Miko Hub ────┼─ devbox
 Slack  ─┤                 └─ build server
 Discord ┘
```

## Quick start

You need Node.js 22 or newer and [Miko daemon installed and running](https://github.com/mikoagents/miko-daemon). Build this fork from source:

```sh
npm ci
npm run build
node dist/index.js
```

Open the local URL printed by Hub. Create the operator account, then follow the browser setup to connect GitHub, Slack, or Discord. Slack Socket Mode works without a public URL.

From the repository where agents should work, run:

```sh
miko hub init
```

Choose the local Hub URL when prompted. The guided setup connects your daemon, uses the default project created during onboarding, detects the selected app connection, writes a safe starter workflow, validates it, and offers to deploy it.

See the [Hub documentation](https://paseo.sh/docs/hub) for PostgreSQL, Docker, public URLs, environment-managed configuration, and production deployment.

## Develop locally

You need Node.js and npm. A fresh checkout runs with an embedded database and no external services:

```sh
npm install
npm run dev
```

Open <http://localhost:3000>. Hub stores the embedded database and its generated authentication secret under `$XDG_DATA_HOME/miko-hub`, falling back to `~/.local/share/miko-hub`, and keeps both across restarts. Set `MIKO_HUB_DATA_DIR` to use a different directory, or set `DATABASE_URL` to use PostgreSQL instead:

```sh
DATABASE_URL=postgres://postgres:postgres@localhost:5432/miko_hub npm run dev
```

Embedded mode supports one Hub process per data directory. Docker Compose continues to run Hub with PostgreSQL.

## Run with Docker Compose

You need Docker, Docker Compose, and a public HTTPS URL when connecting external providers.

```sh
git clone https://github.com/mikoagents/hub.git
cd hub
cp .env.example .env
```

Set these values in `.env`:

```dotenv
MIKO_HUB_APP_URL=https://hub.example.com
MIKO_BOOTSTRAP_ORGANIZATION=My organization
MIKO_BOOTSTRAP_OWNER_EMAIL=me@example.com
MIKO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

Hub generates and stores its authentication secret in the database. Advanced deployments may set
`MIKO_HUB_AUTH_SECRET` to override it without replacing the stored secret.

Billing is optional: leave `STRIPE_SECRET_KEY` unset and Hub runs with no billing surface at all. See [docs/billing.md](docs/billing.md).

Email delivery is optional too: set `RESEND_API_KEY` and `RESEND_FROM` to email organization
invitations, signup verification links, and password-reset links through Resend. Configured
instances require new password accounts to verify their email before sign-in. Without delivery
configuration, managers retain the existing copy-and-share invitation workflow.

Then start Hub and PostgreSQL:

```sh
docker compose up --build -d
```

Open `MIKO_HUB_APP_URL`, sign in with the bootstrap account, and replace its temporary password. Connect a daemon with:

```sh
miko hub connect https://hub.example.com
```

Compose builds the fork image from this checkout. The accepted daemon commit and execution schema are pinned in `miko-compatibility.json`.

See the [self-hosting guide](https://paseo.sh/docs/hub/self-hosting) for production deployment details.
For Linear setup and workflows, see the public [Linear app](https://paseo.sh/docs/hub/self-hosting/linear-app) and [Linear triggers](https://paseo.sh/docs/hub/triggers/linear) guides.

## Programmable Triggers

Triggers are TypeScript/JavaScript projects deployed through the Hub CLI. Use ordinary code for
conditions, loops, parallel work, npm dependencies and external APIs. The existing Triggers page
shows read-only source and revisions, enable/disable and manual actions; Activity shows durable
steps, results, runner logs and agent conversations.

```ts
import { defineTrigger } from "@mikoagents/hub/triggers";

export default defineTrigger({
  name: "hello",
  runner: "local",
  on: [{ source: "manual", event: "run" }],
  grants: {},
  limits: { maxRuntime: "10m" },
  async run(ctx) {
    return ctx.step("handle-input", ctx.event.payload, async (input) => ({ input }));
  },
});
```

Hub coordinates events, schedules and durable journals. A separate trusted runner executes code;
agents continue through the native Miko execution protocol and completion/output contracts.
Provider-specific parameters are passed through faithfully. Explicit grants select targets,
connections and credentials; prompts and output capabilities are authored by the workflow.

See [programmable Triggers](docs/programmable-triggers.md) for building/deploying a project,
runner setup, recovery semantics, API operations and rewriting historical YAML while preserving
identity and history. The [GitHub review example](examples/triggers/github-review) implements
CI waits, formal Reviews, supplemental verification, bounded fixes and independent review of new
heads entirely in Trigger code.

## Scheduled Triggers

Declare an explicit recurrence in `on` and combine it with manual or provider subscriptions.
See [scheduled Triggers](docs/scheduled-triggers.md) for timezone and recovery behavior.

## Public API

Each Hub serves a self-hosted API reference at `/api/reference` and its generated OpenAPI 3.1 contract at `/api/openapi.json`. The short [public API guide](docs/public-api.md) covers CLI login, versioning, credential scopes, and request correlation.

## License

Apache-2.0

The fork uses the [Miko execution boundary](docs/miko-execution.md) and an independently maintained [Miko daemon](https://github.com/mikoagents/miko-daemon).
