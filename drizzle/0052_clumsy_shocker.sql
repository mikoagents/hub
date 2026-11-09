CREATE TABLE "agent_execution_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"execution_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"event" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_execution_logs" ADD CONSTRAINT "agent_execution_logs_execution_id_agent_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."agent_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_execution_logs_execution_id_idx" ON "agent_execution_logs" USING btree ("execution_id","id");