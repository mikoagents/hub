import type { JsonValue } from "../config/compiler.js";

/** Preserve provider messages and tool output while scrubbing credential fields and known tokens. */
export function executionLogEvent(value: unknown, secrets: readonly string[] = []): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const scrubbed = secrets.reduce(
      (text, secret) => (secret.length === 0 ? text : text.replaceAll(secret, "[Redacted]")),
      value,
    );
    return scrubbed
      .replace(/\bBearer\s+[^\s"'<>]+/giu, "Bearer [Redacted]")
      .replace(
        /\b((?:api_?key|access_token|auth_token|token|secret|password)=)[^&\s"'<>]+/giu,
        "$1[Redacted]",
      )
      .replace(
        /\b((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gu,
        "$1[Redacted]",
      );
  }
  if (Array.isArray(value)) return value.map((entry) => executionLogEvent(entry, secrets));
  if (typeof value !== "object") return null;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveField(key, entry) ? "[Redacted]" : executionLogEvent(entry, secrets),
    ]),
  );
}

function sensitiveField(key: string, value: unknown): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (typeof value === "number" && TOKEN_COUNTERS.has(normalized)) return false;
  return /(?:token|secret|password|credential|authorization|cookie|headers|privatekey|apikey|accesskey)|^(?:env|environment|auth)$/u.test(
    normalized,
  );
}
const TOKEN_COUNTERS = new Set([
  "inputtokens",
  "outputtokens",
  "cachedinputtokens",
  "cachedoutputtokens",
  "totaltokens",
  "reasoningtokens",
  "cachecreationinputtokens",
  "cachereadinputtokens",
]);
