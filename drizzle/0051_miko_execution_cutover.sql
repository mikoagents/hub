-- Pause intake and drain or explicitly cancel in-flight work before applying this cutover.
-- Moving an active execution to another protocol would lose its native authority boundary.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_executions WHERE status IN ('spawning', 'running')) THEN
    RAISE EXCEPTION 'Miko cutover requires draining or cancelling all active executions';
  END IF;
END $$;
--> statement-breakpoint
UPDATE daemons SET status = 'revoked', presence = 'offline', disconnected_at = now();
--> statement-breakpoint
UPDATE agent_sessions SET continuation_key = NULL, data = jsonb_set(data, '{continuationKey}', 'null'::jsonb);
