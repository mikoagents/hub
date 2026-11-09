import { z } from "zod";
import { iterationFailure, type Iteration } from "../workflows/iterations.js";

export const completionErrorSchema = z.string().min(1).max(2000).regex(/\S/u);

export function completionFailure(
  iteration: Iteration | undefined,
  output: unknown,
  error?: string,
): string | undefined {
  return error === undefined
    ? iterationFailure(iteration, output)
    : completionErrorSchema.parse(error);
}
