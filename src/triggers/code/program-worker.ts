/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- The private job file is written by this runner after artifact validation; the imported entry is checked before use. */
/* oxlint-disable no-console -- Redirect author console calls into the scoped runner log. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createTriggerContext,
  TriggerSkipped,
  type TriggerDefinition,
  type OperationReply,
  type TriggerValue,
} from "./sdk.js";
import { triggerRequest } from "./http-client.js";
import type { TriggerWorkerInput, TriggerWorkerResult } from "./runner.js";

const filename = process.argv[2];
if (filename === undefined) throw new Error("Trigger job file required");
const input = JSON.parse(await readFile(filename, "utf8")) as TriggerWorkerInput;
const prefix = `/api/v1/triggers/runner/runs/${encodeURIComponent(input.job.run.organizationId)}/${input.job.run.id}`;
const secrets = Object.values(input.secrets).filter((value) => value.length > 0);
const redact = (text: string) =>
  secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text);
function redactData(value: TriggerValue): TriggerValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactData);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactData(item)]),
    );
  return value;
}
const post = <T>(action: string, body: unknown) =>
  triggerRequest<T>(input.url, `${prefix}/${action}`, input.job.leaseToken, body);
let finished = false;
const pendingLogs = new Set<Promise<unknown>>();
async function finish(result: TriggerWorkerResult) {
  if (finished) return;
  finished = true;
  await Promise.allSettled(pendingLogs);
  process.send?.(result, () => process.exit(0));
}
const runtime = createTriggerContext({
  runId: input.job.run.id,
  event: input.job.run.event,
  deadlineAt: input.job.run.deadlineAt,
  startedAt: input.job.run.createdAt,
  secrets: input.secrets,
  transport: {
    operation: (request) => post<OperationReply>("operation", request),
    complete: async (id, result) => {
      await post("complete-operation", { id, ...result });
    },
    log: async (message, data) => {
      await post("log", {
        message: redact(message),
        data: data === undefined ? null : redactData(data),
      });
    },
  },
  onWaiting: () => {
    setImmediate(() => {
      if (!finished && runtime.isWaiting())
        void finish({ status: "suspended", waitingFor: runtime.waitingOperations() });
    });
  },
});
console.log =
  console.info =
  console.warn =
  console.error =
    (...args: unknown[]) => {
      const log = runtime.context
        .log(
          args
            .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
            .join(" "),
        )
        .catch(() => {});
      pendingLogs.add(log);
      void log.finally(() => pendingLogs.delete(log));
    };
process.once("disconnect", () => process.exit(1));
try {
  const module = (await import(pathToFileURL(input.modulePath).href)) as {
    default: TriggerDefinition;
  };
  if (typeof module.default?.run !== "function")
    throw new Error("Trigger bundle must export defineTrigger() as its default export");
  const output = await module.default.run(runtime.context);
  await runtime.drain();
  await finish({ status: "succeeded", output: output === undefined ? null : output });
} catch (error) {
  await runtime.drain();
  await finish(
    error instanceof TriggerSkipped || (error instanceof Error && error.name === "TriggerSkipped")
      ? { status: "skipped", error: redact(error.message) }
      : { status: "failed", error: redact(error instanceof Error ? error.message : String(error)) },
  );
}
