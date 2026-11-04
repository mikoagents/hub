import type { TransactionHandle } from "./runtime/index.js";
import type { Locks } from "./runtime/locks/index.js";

/** Check inside execution creation's transaction; the run and its claims survive restarts. */
export async function workflowGroupBusy(
  client: TransactionHandle,
  locks: Locks,
  run: { id: string; project_id: string; concurrency_key: string | null },
): Promise<boolean> {
  if (run.concurrency_key === null) return false;
  await locks.withTxLock(
    client,
    JSON.stringify(["workflow-group", run.project_id, run.concurrency_key]),
  );
  const result = await client.query(
    `select other.id from trigger_runs other
       join trigger_runs current_run on current_run.id = $1
      where other.project_id = current_run.project_id and other.id <> current_run.id
        and other.concurrency_key = current_run.concurrency_key
        and ((other.status = 'running' and (other.created_at, other.id) < (current_run.created_at, current_run.id))
          or exists (select 1 from workflow_step_runs step join agent_executions execution
            on execution.id = step.agent_execution_id
            where step.trigger_run_id = other.id and (execution.status in ('spawning', 'running')
              or (execution.hub_action is not null and execution.hub_action_completed_at is null))))
      limit 1`,
    [run.id],
  );
  return result.rows.length !== 0;
}
