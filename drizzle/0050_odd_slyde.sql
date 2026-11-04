ALTER TABLE "trigger_runs" ADD COLUMN "concurrency_key" text;--> statement-breakpoint
ALTER TABLE "trigger_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_runs_project_idempotency_unique" ON "trigger_runs" USING btree ("project_id","idempotency_key") WHERE "trigger_runs"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "trigger_runs_project_concurrency_idx" ON "trigger_runs" USING btree ("project_id","concurrency_key","status");