/** Event patterns use a literal match with * as the only wildcard. Safe to share with the UI. */
export function matchesPattern(value: string, pattern: string | string[]): boolean {
  return (Array.isArray(pattern) ? pattern : [pattern]).some((item) =>
    new RegExp(
      `^${item
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*")}$`,
      "u",
    ).test(value),
  );
}
