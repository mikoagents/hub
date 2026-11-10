import { AgentProviderLogos } from "../components/app/agent-provider-logos.js";
import { Spinner } from "../components/app/loading.js";
import type { BrowserDaemon } from "./functions.js";
import { useDaemonProviderSnapshot } from "./provider-snapshot-query.js";

export function DaemonProviders({
  daemon,
  accountId,
  organizationId,
  organizationSlug,
}: {
  daemon: BrowserDaemon;
  accountId: string;
  organizationId: string;
  organizationSlug: string;
}) {
  const connected = daemon.status === "active" && daemon.presence === "connected";
  const snapshot = useDaemonProviderSnapshot({
    accountId,
    organizationId,
    organizationSlug,
    daemonId: daemon.id,
    connectedAt: daemon.connectedAt,
    enabled: connected,
  });

  if (!connected) {
    return <span className="text-muted-foreground">Unavailable</span>;
  }
  if (snapshot.status === "pending") {
    return (
      <span role="status" aria-label="Loading providers" className="flex h-7 items-center">
        <Spinner />
      </span>
    );
  }
  if (snapshot.status === "error") {
    return (
      <span className="text-muted-foreground" title={snapshot.error ?? "Couldn't load providers."}>
        Unavailable
      </span>
    );
  }
  return <AgentProviderLogos providers={snapshot.data.entries} />;
}
