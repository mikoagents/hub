import { z } from "zod";

const AgentStatusSchema = z.enum(["error", "initializing", "idle", "running", "closed"]);

type WireJsonValue =
  | string
  | number
  | boolean
  | null
  | WireJsonValue[]
  | { [key: string]: WireJsonValue };

const JsonValueSchema: z.ZodType<WireJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const ProviderSelectOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

const ProviderModelSchema = z.object({
  provider: z.string(),
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  isSelectable: z.boolean().optional(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
  contextWindowMaxTokens: z.number().optional(),
  thinkingOptions: z.array(ProviderSelectOptionSchema).optional(),
  defaultThinkingOptionId: z.string().optional(),
});

const ProviderModeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  colorTier: z.string().optional(),
});

const ProviderSnapshotEntrySchema = z.object({
  supportsExactMcpPreapproval: z.boolean().optional(),
  provider: z.string(),
  status: z.enum(["ready", "loading", "error", "unavailable"]),
  enabled: z.boolean().optional().default(true),
  source: z.enum(["builtin", "custom"]).optional(),
  error: z.string().optional(),
  models: z.array(ProviderModelSchema).optional(),
  modes: z.array(ProviderModeSchema).optional(),
  fetchedAt: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  defaultModeId: z.string().nullable().optional(),
});

export const HubExecutionAgentSnapshotSchema = z
  .object({
    id: z.string(),
    status: AgentStatusSchema,
  })
  .passthrough();

const HubTimelineItemSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    messageId: z.string().optional(),
    callId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export function isHubFinishExecutionToolName(name: string): boolean {
  return name === "hub.finish_execution" || name === "mcp__hub__finish_execution";
}

export const HubExecutionAgentStreamEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("thread_started"),
      sessionId: z.string(),
      provider: z.string(),
    })
    .passthrough(),
  z.object({ type: z.literal("turn_started"), provider: z.string() }).passthrough(),
  z.object({ type: z.literal("turn_completed"), provider: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("turn_failed"),
      provider: z.string(),
      error: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("turn_canceled"),
      provider: z.string(),
      reason: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("timeline"),
      provider: z.string(),
      item: HubTimelineItemSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("permission_requested"),
      provider: z.string(),
      request: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("permission_resolved"),
      provider: z.string(),
      requestId: z.string(),
      resolution: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("attention_required"),
      provider: z.string(),
      reason: z.enum(["finished", "error", "permission"]),
      timestamp: z.string(),
      shouldNotify: z.boolean(),
    })
    .passthrough(),
]);

export const ProviderSnapshotSchema = z.object({
  cwd: z.string().optional(),
  entries: z.array(ProviderSnapshotEntrySchema),
  generatedAt: z.string(),
});
export type HubExecutionAgentSnapshot = z.infer<typeof HubExecutionAgentSnapshotSchema>;
export type HubExecutionAgentStreamEvent = z.infer<typeof HubExecutionAgentStreamEventSchema>;
export type HubProviderSnapshot = z.infer<typeof ProviderSnapshotSchema>;
export type HubProviderSnapshotEntry = z.infer<typeof ProviderSnapshotEntrySchema>;

// This protocol is versioned independently of Paseo's native session protocol.
export const EXECUTION_PROTOCOL_VERSION = "2.1.0" as const;
export const EXECUTION_PROTOCOL_HEADER = "x-miko-execution-protocol";
export const AgentSnapshotSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: AgentStatusSchema,
  archivedAt: z.unknown().optional(),
  provider: z.string(),
  nativeAgentId: z.string(),
});
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["agent_update", "agent_snapshot"]),
    agent: AgentSnapshotSchema,
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("agent_stream"),
    agentId: z.string(),
    event: HubExecutionAgentStreamEventSchema,
    timestamp: z.string(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export const TimelineCursorSchema = z
  .object({ epoch: z.string().min(1), seq: z.number().int().nonnegative() })
  .strict();
export const TimelineOptionsSchema = z
  .object({
    direction: z.enum(["tail", "before", "after"]).default("tail"),
    cursor: TimelineCursorSchema.optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict();
export const TimelineRowSchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  turnId: z.string().optional(),
  item: z.record(z.string(), JsonValueSchema),
});
export const TimelinePageSchema = z.object({
  epoch: z.string(),
  rows: z.array(TimelineRowSchema).max(200),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
  reset: z.boolean(),
  window: z.object({
    minSeq: z.number().int(),
    maxSeq: z.number().int(),
    nextSeq: z.number().int(),
  }),
  agent: z.object({
    nativeAgentId: z.string(),
    provider: z.string(),
    providerSessionId: z.string().nullable(),
    status: AgentStatusSchema,
    cwd: z.string(),
    model: z.string().nullable(),
    details: z.record(z.string(), JsonValueSchema).optional(),
  }),
});
export type TimelineOptions = z.input<typeof TimelineOptionsSchema>;
export type TimelinePage = z.infer<typeof TimelinePageSchema>;

export const CreateOptionsSchema = z
  .object({
    provider: z.string(),
    title: z.string().optional(),
    workspaceTitle: z.string().optional(),
    background: z.boolean().optional(),
    mode: z.string().optional(),
    model: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    providerOptions: z.record(z.string(), JsonValueSchema).optional(),
    toolPolicy: z.object({
      preapproved: z.array(
        z.object({ kind: z.literal("mcp"), server: z.literal("hub"), tool: z.string() }),
      ),
    }),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    mcpServers: z
      .record(
        z.string(),
        z.object({
          type: z.literal("http"),
          url: z.string().url(),
          headers: z.record(z.string(), z.string()).optional(),
        }),
      )
      .optional(),
    worktree: z
      .discriminatedUnion("mode", [
        z.object({
          mode: z.literal("branch-off"),
          newBranch: z.string(),
          base: z.string().optional(),
        }),
        z.object({ mode: z.literal("checkout-branch"), branch: z.string() }),
        z.object({ mode: z.literal("checkout-pr"), prNumber: z.number().int().positive() }),
      ])
      .optional(),
  })
  .strict();
export type CreateOptions = z.infer<typeof CreateOptionsSchema>;
export const ValidationSchema = z
  .object({
    provider: z.string(),
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    providerOptions: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict();
export const ValidationResultSchema = z.discriminatedUnion("valid", [
  z.object({ valid: z.literal(true) }),
  z.object({
    valid: z.literal(false),
    issues: z.array(
      z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }),
    ),
  }),
]);
const RequestEnvelopeSchema = z.object({
  type: z.literal("miko.request"),
  version: z.literal(EXECUTION_PROTOCOL_VERSION),
  requestId: z.string().min(1),
});
const ReadInputSchema = z.object({ agentId: z.string().min(1) }).strict();
const ControlInputSchema = ReadInputSchema.extend({
  workspaceId: z.string().min(1),
  key: z.string().min(1),
}).strict();
const ProviderInputSchema = z.object({ cwd: z.string().optional() }).strict();
export const RequestSchema = z.discriminatedUnion("operation", [
  RequestEnvelopeSchema.extend({ operation: z.literal("providers"), input: ProviderInputSchema }),
  RequestEnvelopeSchema.extend({
    operation: z.literal("refresh"),
    input: ProviderInputSchema.extend({ providers: z.array(z.string()).optional() }),
  }),
  RequestEnvelopeSchema.extend({ operation: z.literal("validate"), input: ValidationSchema }),
  RequestEnvelopeSchema.extend({
    operation: z.literal("create"),
    input: z.object({ key: z.string().min(1), options: CreateOptionsSchema }).strict(),
  }),
  RequestEnvelopeSchema.extend({ operation: z.literal("get"), input: ReadInputSchema }),
  RequestEnvelopeSchema.extend({
    operation: z.literal("timeline"),
    input: ReadInputSchema.extend(TimelineOptionsSchema.shape).strict(),
  }),
  RequestEnvelopeSchema.extend({
    operation: z.literal("submit"),
    input: ReadInputSchema.extend({ messageId: z.string().min(1), text: z.string() }),
  }),
  RequestEnvelopeSchema.extend({ operation: z.literal("restore"), input: ControlInputSchema }),
  RequestEnvelopeSchema.extend({ operation: z.literal("cancel"), input: ControlInputSchema }),
  RequestEnvelopeSchema.extend({ operation: z.literal("cleanup"), input: ControlInputSchema }),
  RequestEnvelopeSchema.extend({ operation: z.literal("watch"), input: ReadInputSchema }),
  RequestEnvelopeSchema.extend({ operation: z.literal("unwatch"), input: ReadInputSchema }),
  RequestEnvelopeSchema.extend({
    operation: z.literal("receipt"),
    input: z.object({ key: z.string().min(1) }).strict(),
  }),
]);
export type ExecutionRequest = z.infer<typeof RequestSchema>;
export const ResponseSchema = z.object({
  type: z.literal("miko.response"),
  version: z.literal(EXECUTION_PROTOCOL_VERSION),
  requestId: z.string(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export const HelloSchema = z.object({
  type: z.literal("miko.hello"),
  version: z.literal(EXECUTION_PROTOCOL_VERSION),
});
export const ReadySchema = z.object({
  type: z.literal("miko.ready"),
  version: z.literal(EXECUTION_PROTOCOL_VERSION),
  permissions: z.array(z.string()),
});
export const EventSchema = z.object({
  type: z.literal("miko.event"),
  version: z.literal(EXECUTION_PROTOCOL_VERSION),
  event: AgentEventSchema,
});
