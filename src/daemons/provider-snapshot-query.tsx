import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo } from "react";
import { snapshotQueryOptions, useSnapshotQuery } from "../queries/index.js";
import { daemonProviderSnapshot } from "./functions.js";
import { daemonProviderQueryKey, PROVIDER_SNAPSHOT_STALE_TIME_MS } from "./provider-snapshot.js";

/** Both the daemon table and trigger editor use the same scope and freshness rules. */
export function useDaemonProviderSnapshot(scope: {
  accountId: string;
  organizationId: string;
  organizationSlug: string;
  daemonId: string | undefined;
  connectedAt: string | null | undefined;
  cwd?: string;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const load = useServerFn(daemonProviderSnapshot);
  const { accountId, organizationId, organizationSlug, daemonId, connectedAt, enabled } = scope;
  const cwd = scope.cwd?.trim() || undefined;
  const queryKey = useMemo(
    () =>
      daemonProviderQueryKey({
        accountId,
        organizationId,
        daemonId,
        connectedAt,
        ...(cwd === undefined ? {} : { cwd }),
      }),
    [accountId, organizationId, daemonId, connectedAt, cwd],
  );
  const read = useCallback(
    (refresh = false) =>
      load({
        data: {
          organizationSlug,
          daemonId: daemonId!,
          ...(cwd === undefined ? {} : { cwd }),
          ...(refresh ? { refresh: true } : {}),
        },
      }),
    [load, organizationSlug, daemonId, cwd],
  );
  const snapshot = useSnapshotQuery({
    queryKey,
    enabled: enabled && daemonId !== undefined,
    staleTime: PROVIDER_SNAPSHOT_STALE_TIME_MS,
    queryFn: read,
  });
  const refresh = useCallback(() => {
    if (!enabled || daemonId === undefined) return;
    // The query owns errors and retains its last successful data, just like ordinary reads.
    void queryClient
      .fetchQuery(
        snapshotQueryOptions({
          queryKey,
          staleTime: 0,
          queryFn: () => read(true),
        }),
      )
      .catch(() => undefined);
  }, [queryClient, queryKey, read, enabled, daemonId]);
  return { ...snapshot, refresh };
}
