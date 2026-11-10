import { usePersistedChoice } from "../preferences/persisted-choice.js";

const TRIGGER_STATUS_FILTERS = ["all", "enabled", "disabled"] as const;

export function useTriggerStatusFilter(organizationId: string) {
  const { value, setValue, ready } = usePersistedChoice(
    `paseo-hub-trigger-status:${organizationId}`,
    TRIGGER_STATUS_FILTERS,
    "all",
  );
  return { filter: value, setFilter: setValue, ready };
}
