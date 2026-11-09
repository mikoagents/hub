// Shared execution DTOs; native Paseo RPCs belong to Miko's service adapter.
export {
  HubExecutionAgentSnapshotSchema,
  HubExecutionAgentStreamEventSchema,
  isHubFinishExecutionToolName,
  type HubExecutionAgentSnapshot,
  type HubExecutionAgentStreamEvent,
  type HubProviderSnapshot,
  type HubProviderSnapshotEntry,
} from "../miko/protocol.js";
export type HubExecutionControlAction = "interrupt" | "archive";
