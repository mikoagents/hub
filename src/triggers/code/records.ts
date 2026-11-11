import type { TriggerEvent } from "./sdk.js";
import type { TriggerFailure } from "./sdk-errors.js";

export type CodeRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped";
export interface CodeRun {
  id: string;
  organizationId: string;
  triggerId: string;
  revisionId: string;
  runner: string;
  event: TriggerEvent;
  status: CodeRunStatus;
  output: unknown;
  error: string | null;
  createdAt: string;
  deadlineAt: string;
  completedAt: string | null;
  leaseHash: string | null;
  leaseExpiresAt: string | null;
  leaseRunnerId: string | null;
  wakeAt: string | null;
  waitingFor: string[];
  cleanupPending: boolean;
}
export interface CodeOperation {
  runId: string;
  id: string;
  kind: string;
  input: unknown;
  inputHash: string;
  status: "running" | "waiting" | "completed" | "failed";
  output: unknown;
  error: string | null;
  failure?: TriggerFailure;
  wakeAt: string | null;
  childRunId: string | null;
  leaseHash: string;
  createdAt: string;
}
export interface CodeRunner {
  id: string;
  organizationId: string;
  name: string;
  tokenHash: string;
  revoked: boolean;
}
export interface CodeEvent {
  sequence: number;
  triggerId: string;
  event: TriggerEvent;
}
export interface CodeLog {
  id: string;
  runId: string;
  time: string;
  message: string;
  data: unknown;
}
export interface CodeState {
  key: string;
  kind: "state" | "claim" | "lock";
  value: unknown;
  ownerRunId: string | null;
}

export interface TriggerCodeTransaction {
  getRun(id: string): Promise<CodeRun | undefined>;
  putRun(run: CodeRun): Promise<void>;
  listRuns(triggerId?: string, limit?: number): Promise<CodeRun[]>;
  activeRuns(after?: string): Promise<CodeRun[]>;
  activeRevisions(triggerId: string): Promise<string[]>;
  nextQueuedRun(runner: string): Promise<CodeRun | undefined>;
  runForEvent(triggerId: string, event: TriggerEvent): Promise<CodeRun | undefined>;
  getOperation(runId: string, id: string): Promise<CodeOperation | undefined>;
  putOperation(operation: CodeOperation): Promise<void>;
  operations(runId: string): Promise<CodeOperation[]>;
  appendEvent(triggerId: string, event: TriggerEvent): Promise<boolean>;
  events(triggerId: string, after: number, since: string): Promise<CodeEvent[]>;
  getState(triggerId: string, kind: CodeState["kind"], key: string): Promise<CodeState | undefined>;
  putState(triggerId: string, state: CodeState): Promise<void>;
  deleteState(triggerId: string, kind: CodeState["kind"], key: string): Promise<void>;
  releaseLocks(runId: string): Promise<void>;
  putRunner(runner: CodeRunner): Promise<void>;
  log(log: CodeLog): Promise<void>;
  logs(runId: string, limit?: number): Promise<CodeLog[]>;
}
export interface TriggerCodeRepository {
  transaction<T>(
    organizationId: string,
    operation: (transaction: TriggerCodeTransaction) => Promise<T>,
  ): Promise<T>;
  runnerByHash(hash: string): Promise<CodeRunner | undefined>;
  organizations(): Promise<string[]>;
}

export function terminal(run: Pick<CodeRun, "status">): boolean {
  return ["succeeded", "failed", "timed_out", "cancelled", "skipped"].includes(run.status);
}
