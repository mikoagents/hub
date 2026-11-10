import { useCallback, useEffect, useState } from "react";

/**
 * A short choice remembered in the browser, one key per organization. Invalid or missing values
 * fall back, and a write from another tab is picked up, so two views of the same list agree.
 * Callers pass a stable `allowed` array; a fresh array each render would re-read storage forever.
 */
export function usePersistedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
) {
  const [selection, setSelection] = useState<{ key: string; value: T } | null>(null);

  useEffect(() => {
    const restore = () => {
      setSelection({ key, value: readPersistedChoice(key, allowed, fallback) });
    };
    const synchronize = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      try {
        if (event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      restore();
    };
    restore();
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, [allowed, fallback, key]);

  const setValue = useCallback(
    (value: string) => {
      if (!isChoice(value, allowed)) return;
      setSelection({ key, value });
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Persist only when the browser allows it; keep the current selection either way.
      }
    },
    [allowed, key],
  );

  const ready = selection?.key === key;
  return { value: ready ? selection.value : fallback, setValue, ready };
}

export function readPersistedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  try {
    return choiceFromStored(window.localStorage.getItem(key), allowed, fallback);
  } catch {
    // The control still works for this visit when browser storage is unavailable.
    return fallback;
  }
}

/** The stored string when it is one of the choices, otherwise the fallback. */
export function choiceFromStored<T extends string>(
  stored: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return isChoice(stored, allowed) ? stored : fallback;
}

function isChoice<T extends string>(value: string | null, allowed: readonly T[]): value is T {
  return value !== null && (allowed as readonly string[]).includes(value);
}
