-- Protocol 2 runs only local providers. Drain active work before upgrading both peers.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agent_executions WHERE status IN ('spawning', 'running')) THEN
    RAISE EXCEPTION 'Removing execution backends requires draining or cancelling all active executions';
  END IF;
END $$;
--> statement-breakpoint
-- Release every old continuation binding; remote sessions must never resume as local ones.
-- Keep historical native references while removing the retired selector from persisted data.
UPDATE agent_sessions
SET continuation_key = NULL,
    data = jsonb_set(
      jsonb_set(
        jsonb_set(data, '{continuationKey}', 'null'::jsonb),
        '{creationOptions}', COALESCE(data->'creationOptions', '{}'::jsonb) - 'backend'
      ),
      '{runtimeBinding}',
      CASE WHEN jsonb_typeof(data->'runtimeBinding') = 'object'
        THEN (data->'runtimeBinding') - 'backend'
        ELSE 'null'::jsonb
      END
    );
