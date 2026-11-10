/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Responses come from the configured authenticated Hub; consumers validate artifact and operation envelopes. */
export async function triggerRequest<T>(
  baseUrl: string,
  path: string,
  token: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (url.origin !== new URL(baseUrl).origin)
    throw new Error("Trigger request must stay on the configured Hub origin");
  const response = await fetch(url, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null);
    throw Object.assign(
      new Error(
        `Hub returned HTTP ${response.status}: ${typeof detail === "object" && detail !== null && "detail" in detail ? String(detail.detail) : response.statusText}`,
      ),
      { status: response.status },
    );
  }
  return (await response.json()) as T;
}
