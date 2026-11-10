import type { AuthServer } from "../auth/server.js";
import type { Database } from "../db/types.js";
import { resolveRouteTenant } from "../projects/access.js";
import type { HubProviderSnapshot } from "../hub/protocol.js";
import type { DaemonConnection } from "./protocol.js";
import { PROVIDER_SNAPSHOT_STALE_TIME_MS } from "./provider-snapshot.js";

interface CachedSnapshot {
  value?: HubProviderSnapshot;
  expiresAt: number;
  pending?: Promise<HubProviderSnapshot>;
  refreshing: boolean;
}

export class DaemonProviderCatalog {
  // Registry connection wrappers are recreated for each lookup; agents identifies the socket.
  // A reconnect therefore starts a new cache, and closed connections can be collected.
  private readonly snapshots = new WeakMap<
    DaemonConnection["agents"],
    Map<string, CachedSnapshot>
  >();

  constructor(
    private readonly database: Database,
    private readonly auth: AuthServer,
    private readonly connectionForDaemon: (daemonId: string) => DaemonConnection | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  async read(
    request: Request,
    input: {
      organizationSlug: string;
      daemonId: string;
      cwd?: string;
      refresh?: boolean;
    },
  ): Promise<HubProviderSnapshot> {
    const { tenant } = await resolveRouteTenant(this.auth, this.database, request, {
      organizationSlug: input.organizationSlug,
    });
    const daemon = await this.database.findDaemonForOrganization(
      tenant.organization.id,
      input.daemonId,
    );
    if (daemon?.status !== "active") throw new Error("daemon_unavailable");
    const connection = this.connectionForDaemon(daemon.id);
    if (connection === undefined) throw new Error("daemon_not_connected");
    const cwd = input.cwd?.trim() || undefined;
    const scope = cwd === undefined ? {} : { cwd };
    const key = JSON.stringify([tenant.organization.id, daemon.id, cwd ?? null]);
    let snapshots = this.snapshots.get(connection.agents);
    if (snapshots === undefined) {
      snapshots = new Map();
      this.snapshots.set(connection.agents, snapshots);
    }
    const cached = snapshots.get(key);
    const refresh = input.refresh === true;
    if (cached?.pending !== undefined && (!refresh || cached.refreshing)) return cached.pending;
    if (!refresh && cached?.value !== undefined && cached.expiresAt > this.now()) {
      return cached.value;
    }
    const entry: CachedSnapshot = { expiresAt: 0, refreshing: refresh };
    snapshots.set(key, entry);
    // Bound directory-scoped catalogs even when an editor visits many different directories.
    if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value!);
    const cache = snapshots;
    entry.pending = (async () => {
      try {
        if (refresh) await connection.refreshProviderSnapshot(scope);
        const value = await connection.getProviderSnapshot(scope);
        if (cache.get(key) === entry) {
          cache.set(key, {
            value,
            expiresAt: this.now() + PROVIDER_SNAPSHOT_STALE_TIME_MS,
            refreshing: false,
          });
        }
        return value;
      } catch (error) {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      }
    })();
    return entry.pending;
  }
}
