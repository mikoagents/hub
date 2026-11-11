export interface TriggerFailure {
  code: string;
  retryable: boolean;
  outcome: "rejected" | "unknown";
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
}

/** Failure metadata is persisted with the operation and survives runner restarts. */
export class TriggerOperationError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasFailure(value, ["TriggerOperationError", "GitHubRequestError"]);
  }
  constructor(
    message: string,
    readonly failure: TriggerFailure,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = "TriggerOperationError";
  }
}

export class GitHubRequestError extends TriggerOperationError {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return hasFailure(value, ["GitHubRequestError"]);
  }
  constructor(message: string, failure: TriggerFailure, operationId?: string) {
    super(message, failure, operationId);
    this.name = "GitHubRequestError";
  }
  get status(): number | undefined {
    return this.failure.status;
  }
  get requestId(): string | undefined {
    return this.failure.requestId;
  }
  get retryAfterMs(): number | undefined {
    return this.failure.retryAfterMs;
  }
}

function hasFailure(value: unknown, names: string[]): boolean {
  if (!(value instanceof Error) || !names.includes(value.name) || !("failure" in value))
    return false;
  try {
    parseTriggerFailure(value.failure);
    return true;
  } catch {
    return false;
  }
}

export function operationError(message: string, failure?: TriggerFailure, id?: string): Error {
  if (failure === undefined) return new Error(message);
  return failure.code.startsWith("GITHUB_")
    ? new GitHubRequestError(message, failure, id)
    : new TriggerOperationError(message, failure, id);
}

export function errorFailure(error: unknown): TriggerFailure | undefined {
  return error instanceof TriggerOperationError ? error.failure : undefined;
}

/** Validate metadata arriving over the runner protocol; arbitrary error properties are not copied. */
export function parseTriggerFailure(value: unknown): TriggerFailure {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid operation failure");
  const code: unknown = Reflect.get(value, "code");
  const retryable: unknown = Reflect.get(value, "retryable");
  const outcome: unknown = Reflect.get(value, "outcome");
  if (
    typeof code !== "string" ||
    !/^[A-Z_]{1,80}$/u.test(code) ||
    typeof retryable !== "boolean" ||
    (outcome !== "rejected" && outcome !== "unknown")
  )
    throw new TypeError("Invalid operation failure");
  const failure: TriggerFailure = { code, retryable, outcome };
  for (const key of ["status", "retryAfterMs"] as const) {
    const item: unknown = Reflect.get(value, key);
    if (item === undefined) continue;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)
      throw new TypeError("Invalid operation failure number");
    failure[key] = item;
  }
  const requestId: unknown = Reflect.get(value, "requestId");
  if (requestId !== undefined) {
    if (typeof requestId !== "string" || requestId.length > 200)
      throw new TypeError("Invalid operation request id");
    failure.requestId = requestId;
  }
  return failure;
}
