import { z } from "zod";

/** Explicit run policy; provider events otherwise retain their existing parallel behavior. */
export const CoordinationSchema = z
  .object({
    serialize: z.literal("conversation").optional(),
    deduplicate: z.literal("event").optional(),
  })
  .strict()
  .refine(
    (value) => value.serialize !== undefined || value.deduplicate !== undefined,
    "Coordination must enable serialization or deduplication",
  );

export type Coordination = z.infer<typeof CoordinationSchema>;
