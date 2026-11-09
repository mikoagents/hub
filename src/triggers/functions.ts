import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { respondOk, type Result } from "../contract/respond.js";
import { respondWithFailure } from "../failures/index.js";
import { getApplication } from "../server/runtime.js";
import type { TriggerDashboard } from "./dashboard.js";

const scopeSchema = z.object({ organizationSlug: z.string().trim().min(1).max(100) });
const saveSchema = scopeSchema.extend({
  triggerId: z.string().uuid().optional(),
  yaml: z.string().min(1),
});
const activityScopeSchema = scopeSchema
  .extend({ triggerId: z.string().uuid(), runId: z.string().uuid() })
  .strict();
const activityLogsSchema = activityScopeSchema
  .extend({
    executionId: z.string().uuid(),
    after: z
      .string()
      .regex(/^(?:0|[1-9][0-9]{0,18})$/u)
      .refine((value) => value.length < 19 || value <= "9223372036854775807")
      .default("0"),
  })
  .strict();

export const triggerActivitySnapshot = createServerFn({ method: "GET" })
  .validator(activityScopeSchema)
  .handler(async ({ data }): Promise<Result<TriggerActivitySnapshot>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.activityRunSnapshot(getRequest(), data));
    } catch (error) {
      return respondWithFailure(
        error,
        triggerContext("trigger.activity.detail", data.organizationSlug),
        {
          fallback: "Hub couldn't load this run's details. Try again.",
          notFound: "Run unavailable.",
        },
      );
    }
  });

export const triggerActivityLogs = createServerFn({ method: "GET" })
  .validator(activityLogsSchema)
  .handler(async ({ data }): Promise<Result<TriggerActivityLogs>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.activityRunLogs(getRequest(), data));
    } catch (error) {
      return respondWithFailure(
        error,
        triggerContext("trigger.activity.logs", data.organizationSlug),
        {
          fallback: "Hub couldn't load this run's log. Try again.",
          notFound: "Run unavailable.",
        },
      );
    }
  });

export type TriggerActivitySnapshot = Awaited<ReturnType<TriggerDashboard["activityRunSnapshot"]>>;
export type TriggerActivityLogs = Awaited<ReturnType<TriggerDashboard["activityRunLogs"]>>;

export const triggerSnapshot = createServerFn({ method: "GET" })
  .validator(scopeSchema)
  .handler(async ({ data }): Promise<Result<TriggerSnapshot>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      return respondOk(await dashboard.snapshot(getRequest(), data.organizationSlug));
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.list", data.organizationSlug), {
        fallback: "Hub couldn't load this organization's triggers. Reload the page.",
      });
    }
  });

export const saveTrigger = createServerFn({ method: "POST" })
  .validator(saveSchema)
  .handler(async ({ data }): Promise<Result<{ state: "complete" }>> => {
    try {
      const dashboard = (await getApplication()).triggerDashboard;
      if (dashboard == null) throw new Error("trigger dashboard unavailable");
      await dashboard.save(getRequest(), data.organizationSlug, {
        ...(data.triggerId === undefined ? {} : { triggerId: data.triggerId }),
        yaml: data.yaml,
      });
      return respondOk({ state: "complete" });
    } catch (error) {
      return respondWithFailure(error, triggerContext("trigger.save", data.organizationSlug), {
        fallback: error instanceof Error ? error.message : "Hub couldn't save this trigger.",
        forbidden: "You don't have permission to manage triggers.",
        validation: error instanceof Error ? error.message : "This trigger is invalid.",
        conflict: "A trigger with this name already exists.",
      });
    }
  });

export type TriggerSnapshot = Awaited<ReturnType<TriggerDashboard["snapshot"]>>;

function triggerContext(operation: string, organizationSlug: string) {
  return { operation, component: "triggers", organizationSlug } as const;
}
