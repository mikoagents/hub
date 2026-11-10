/** Provider discovery is relatively expensive; ordinary reads share a five-minute snapshot. */
export const PROVIDER_SNAPSHOT_STALE_TIME_MS = 5 * 60_000;

export function daemonProviderQueryKey(scope: {
  accountId: string;
  organizationId: string;
  daemonId: string | undefined;
  connectedAt: string | null | undefined;
  cwd?: string;
}) {
  return [
    "daemon-provider-snapshot",
    scope.accountId,
    scope.organizationId,
    scope.daemonId,
    scope.connectedAt,
    scope.cwd?.trim() || null,
  ] as const;
}
