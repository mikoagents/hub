/** Data-only routing for subscriptions held by accepted runs on older revisions. */
export function holdsProviderSubscription(
  subscriptions: unknown,
  provider: string,
  connection: string,
  resource: string | undefined,
): boolean {
  return (
    Array.isArray(subscriptions) &&
    subscriptions.some(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "source" in item &&
        item.source === provider &&
        "connection" in item &&
        item.connection === connection &&
        (!("resource" in item) || item.resource === undefined || item.resource === resource),
    )
  );
}

export function storedSubscriptions(evidence: unknown): unknown {
  if (typeof evidence !== "object" || evidence === null || !("artifact" in evidence)) return [];
  const artifact = evidence.artifact;
  if (typeof artifact !== "object" || artifact === null || !("manifest" in artifact)) return [];
  const manifest = artifact.manifest;
  return typeof manifest === "object" && manifest !== null && "on" in manifest ? manifest.on : [];
}
