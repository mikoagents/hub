/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- Child messages are produced by the bundled worker in an authenticated run. */
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { validateArtifact } from "./contract.js";
import { triggerRequest } from "./http-client.js";
import type { TriggerJob } from "./service.js";

export interface TriggerRunnerOptions {
  url: string;
  token: string;
  directory: string;
  secrets?: Readonly<Record<string, string>>;
  concurrency?: number;
  pollMilliseconds?: number;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
}
export interface TriggerWorkerInput {
  job: TriggerJob;
  url: string;
  modulePath: string;
  secrets: Record<string, string>;
}
export interface TriggerWorkerResult {
  status: "suspended" | "succeeded" | "failed" | "skipped";
  output?: unknown;
  error?: string;
  waitingFor?: string[];
}

/** Only this process owns the child PIDs and workspaces it creates. */
export async function runTriggerRunner(options: TriggerRunnerOptions): Promise<void> {
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error("Runner concurrency must be between 1 and 16");
  const shutdown = new AbortController();
  const abort = () => shutdown.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) shutdown.abort();
  const tasks = new Set<Promise<void>>();
  try {
    while (!shutdown.signal.aborted) {
      if (tasks.size >= concurrency) {
        await Promise.race(tasks);
        continue;
      }
      try {
        const { job } = await triggerRequest<{ job: TriggerJob | null }>(
          options.url,
          "/api/v1/triggers/runner/lease",
          options.token,
          {},
        );
        if (job !== null) {
          const task = executeTriggerJob(job, {
            ...options,
            directory,
            signal: shutdown.signal,
          }).catch((error) => {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
          continue;
        }
      } catch (error) {
        if (shutdown.signal.aborted) break;
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      await delay(options.pollMilliseconds ?? 1000, undefined, { signal: shutdown.signal }).catch(
        () => {},
      );
    }
  } finally {
    shutdown.abort();
    await Promise.allSettled(tasks);
    options.signal?.removeEventListener("abort", abort);
  }
}

export async function executeTriggerJob(
  job: TriggerJob,
  options: TriggerRunnerOptions,
): Promise<void> {
  const artifact = validateArtifact(job.artifact);
  const directory = await mkdtemp(join(resolve(options.directory), "run-"));
  const modulePath = join(directory, "trigger.mjs");
  const prefix = `/api/v1/triggers/runner/runs/${encodeURIComponent(job.run.organizationId)}/${job.run.id}`;
  const post = (action: string, body: unknown) =>
    triggerRequest(options.url, `${prefix}/${action}`, job.leaseToken, body);
  let child: ChildProcess | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let abortChild = () => {};
  try {
    const secrets: Record<string, string> = {};
    for (const name of artifact.manifest.grants.secrets ?? []) {
      const value = Object.hasOwn(options.secrets ?? {}, name)
        ? options.secrets?.[name]
        : undefined;
      if (value === undefined)
        throw new Error(`Runner operator has not configured granted secret: ${name}`);
      secrets[name] = value;
    }
    await writeFile(modulePath, artifact.code, { mode: 0o600 });
    const inputFile = join(directory, "job.json");
    await writeFile(
      inputFile,
      JSON.stringify({ job, url: options.url, modulePath, secrets } satisfies TriggerWorkerInput),
      { mode: 0o600 },
    );
    const worker = workerPath("program-worker");
    const result = await new Promise<TriggerWorkerResult>((resolveResult, reject) => {
      let completed = false;
      child = fork(worker.path, [inputFile], {
        cwd: directory,
        detached: process.platform !== "win32",
        execArgv: ["--max-old-space-size=256", ...worker.execArgv],
        env: runnerEnvironment(),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000);
      });
      abortChild = () => {
        stopChild(child);
        if (!completed) {
          completed = true;
          reject(new Error("Trigger worker stopped"));
        }
      };
      options.signal?.addEventListener("abort", abortChild, { once: true });
      if (options.signal?.aborted) abortChild();
      heartbeat = setInterval(() => {
        void post("heartbeat", {}).catch(() => abortChild());
      }, 10_000);
      deadline = setTimeout(abortChild, Math.max(1, Date.parse(job.run.deadlineAt) - Date.now()));
      child.once("message", (message) => {
        if (completed) return;
        completed = true;
        resolveResult(message as TriggerWorkerResult);
      });
      child.once("error", (error) => {
        if (!completed) {
          completed = true;
          reject(error);
        }
      });
      child.once("exit", (code) => {
        if (!completed) {
          completed = true;
          reject(new Error(`Trigger worker exited ${String(code)}: ${stderr}`));
        }
      });
    });
    await post("report", result);
  } catch (error) {
    // A runner shutdown is a lost lease, not a workflow failure. The Hub will
    // fence this worker and replay its journal after the lease expires.
    if (options.signal?.aborted) return;
    // A stale lease cannot change a terminal or reassigned run.
    await post("report", {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    if (deadline !== undefined) clearTimeout(deadline);
    options.signal?.removeEventListener("abort", abortChild);
    await cleanupChild(child);
    await rm(directory, { recursive: true, force: true });
  }
}

/** No inherited Hub DB, provider auth, Node loaders or daemon registration. */
export function runnerEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"], LANG: "en_US.UTF-8", NODE_ENV: "production" };
}
export function workerPath(name: string) {
  const javascript = fileURLToPath(new URL(`./${name}.js`, import.meta.url));
  if (existsSync(javascript)) return { path: javascript, execArgv: [] as string[] };
  return {
    path: fileURLToPath(new URL(`./${name}.ts`, import.meta.url)),
    execArgv: [
      "--import",
      fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    ],
  };
}
function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (child?.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    /* Already exited. */
  }
}

async function cleanupChild(child: ChildProcess | undefined) {
  if (child?.pid === undefined) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  stopChild(child);
  if (child.exitCode === null && child.signalCode === null)
    await Promise.race([exited, delay(250)]);
  // Also clean up descendants that outlived the worker's main process.
  stopChild(child, "SIGKILL");
}
