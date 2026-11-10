import { z } from "zod";
import type { AuthoredStep, JsonValue } from "../config/compiler.js";

export const IterationsSchema = z.object({ max_runs: z.number().int().min(2).max(24) }).strict();
export const IterationSchema = z
  .object({
    index: z.number().int().min(1),
    limit: z.number().int().min(2).max(24),
  })
  .strict()
  .refine((value) => value.index <= value.limit, "Iteration exceeds its limit");
export type Iteration = z.infer<typeof IterationSchema>;

export function iterationDeadlinePrompt(
  iteration: Iteration | undefined,
  deadlineAt: Date,
  maxRuntimeMs: number,
): string {
  if (iteration === undefined) return "";
  const reserveMs = Math.min(10 * 60_000, Math.floor(maxRuntimeMs / 5));
  const handoffAt = new Date(deadlineAt.getTime() - reserveMs);
  return `\nHub hard deadline: ${deadlineAt.toISOString()}\nHandoff deadline: ${handoffAt.toISOString()}\nThese absolute times include agent startup and prompt delivery. Do not restart the runtime budget from your local start time. By the handoff deadline, stop further repair commands, save the exact candidate and evidence, release owned resources, and call finish_execution with the required output. Publish progress early; do not postpone the completion callback for a final status reread.`;
}

const BlockerSchema = z
  .object({
    kind: z.enum(["permission", "human_decision", "hardware", "external_service"]),
    reason: z.string().min(1).max(2000),
  })
  .strict();

export function iterationFailure(
  iteration: Iteration | undefined,
  output: unknown,
): string | undefined {
  if (
    iteration === undefined ||
    typeof output !== "object" ||
    output === null ||
    Reflect.get(output, "outcome") !== "blocked"
  )
    return undefined;
  const blocker = BlockerSchema.parse(Reflect.get(output, "blocker"));
  return `external_blocker:${blocker.kind}: ${blocker.reason}`;
}

export function iterationSteps(step: AuthoredStep, limit: number): AuthoredStep[] {
  return Array.from({ length: limit }, (_, ordinal) => {
    const index = ordinal + 1;
    const previous = `run-${ordinal}`;
    const continuing = Array.from(
      { length: ordinal },
      (_segment, prior) => `steps.run-${prior + 1}.outputs.outcome == 'continue'`,
    ).join(" && ");
    return {
      ...step,
      id: `run-${index}`,
      ...(ordinal === 0 ? {} : { if: `\${{ ${continuing} }}` }),
      prompt: [
        ...step.prompt,
        {
          text: `Execution segment ${index}/${limit}. Save the exact candidate and validation evidence before yielding. Finish with output.outcome=continue while repair work remains; complete only after the requested work is verified. Only documented external intervention may use blocked.`,
        },
        ...(ordinal === 0
          ? []
          : [{ text: `Previous checkpoint:\n\${{ steps.${previous}.outputs.checkpoint }}` }]),
      ],
      output: { schema: iterationOutput(index === limit) },
    };
  });
}

function iterationOutput(final: boolean): Record<string, JsonValue> {
  const normal = final ? ["complete"] : ["complete", "continue"];
  return {
    type: "object",
    required: ["outcome", "checkpoint"],
    additionalProperties: false,
    properties: {
      outcome: { type: "string", enum: [...normal, "blocked"] },
      checkpoint: { type: "string", minLength: 1, maxLength: 16000 },
      blocker: {
        type: "object",
        required: ["kind", "reason"],
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["permission", "human_decision", "hardware", "external_service"],
          },
          reason: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
    oneOf: [
      { properties: { outcome: { const: "blocked" }, blocker: {} }, required: ["blocker"] },
      {
        properties: { outcome: { enum: normal } },
        not: { properties: { blocker: {} }, required: ["blocker"] },
      },
    ],
  };
}
