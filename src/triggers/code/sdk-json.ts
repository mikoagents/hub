/** Render JSON consistently before and after durable storage, including nested objects. */
export function stableJson(value: unknown, space?: number): string {
  function normalize(item: unknown): unknown {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (
      typeof item === "object" &&
      item !== null &&
      [Object.prototype, null].includes(Reflect.getPrototypeOf(item))
    )
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => {
            if (a < b) return -1;
            return a > b ? 1 : 0;
          })
          .map(([key, child]) => [key, normalize(child)]),
      );
    throw new TypeError(
      "Trigger data must be JSON: undefined, dates and non-finite numbers are unsupported",
    );
  }
  return JSON.stringify(normalize(value), null, space);
}

/** Return an independent JSON value with the same representation on initial execution and replay. */
export function durableJson(value: unknown): unknown {
  return JSON.parse(stableJson(value));
}
