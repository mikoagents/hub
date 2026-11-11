import { GitHubRequestError, type TriggerFailure } from "./sdk-errors.js";

/** Server-side GitHub transport. Tokens never enter the authored SDK or durable operation data. */
export async function requestGitHub(
  request: Record<string, unknown>,
  token: string,
  deadlineAt: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const method = String(request["method"]);
  let response: Response;
  const transportFailure = () =>
    new GitHubRequestError("GitHub transport failed", {
      code: "GITHUB_TRANSPORT",
      retryable: method === "GET",
      outcome: "unknown",
    });
  try {
    response = await fetcher(`https://api.github.com${String(request["path"])}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        "content-type": "application/json",
      },
      ...(request["body"] === undefined ? {} : { body: JSON.stringify(request["body"]) }),
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(15_000, Math.max(1, Date.parse(deadlineAt) - Date.now())),
      ),
    });
  } catch {
    throw transportFailure();
  }
  const headers = Object.fromEntries(
    [
      "link",
      "retry-after",
      "x-github-request-id",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ].flatMap((key) => {
      const value = response.headers.get(key);
      return value === null ? [] : [[key, value]];
    }),
  );
  if (!response.ok) {
    const failure = httpFailure(method, response.status, headers);
    await response.body?.cancel().catch(() => {});
    throw new GitHubRequestError(`GitHub request failed with HTTP ${response.status}`, failure);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw transportFailure();
  }
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new GitHubRequestError("GitHub response exceeds 1 MiB; paginate the request", {
      code: "GITHUB_RESPONSE_SIZE",
      retryable: false,
      outcome: method === "GET" ? "rejected" : "unknown",
      status: response.status,
    });
  let data: unknown;
  try {
    data = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new GitHubRequestError("GitHub response is not JSON", {
      code: "GITHUB_RESPONSE_FORMAT",
      retryable: false,
      outcome: method === "GET" ? "rejected" : "unknown",
      status: response.status,
    });
  }
  return request["response"] === true ? { data, status: response.status, headers } : data;
}

function httpFailure(
  method: string,
  status: number,
  headers: Record<string, string>,
): TriggerFailure {
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0"));
  const failure: TriggerFailure = {
    code: "GITHUB_HTTP",
    status,
    retryable: method === "GET" && (rateLimited || status >= 500),
    outcome: method !== "GET" && status >= 500 ? "unknown" : "rejected",
    ...(headers["x-github-request-id"] === undefined
      ? {}
      : { requestId: headers["x-github-request-id"].slice(0, 200) }),
  };
  const delay = retryAfter(headers, rateLimited);
  if (Number.isFinite(delay))
    failure.retryAfterMs = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(delay)));
  return failure;
}
function retryAfter(headers: Record<string, string>, rateLimited: boolean): number {
  const after = headers["retry-after"];
  if (after !== undefined) {
    if (/^\d+(?:\.\d+)?$/u.test(after)) return Number(after) * 1000;
    return Date.parse(after) - Date.now();
  }
  const reset = headers["x-ratelimit-reset"];
  if (rateLimited && reset !== undefined) return Number(reset) * 1000 - Date.now();
  return NaN;
}
