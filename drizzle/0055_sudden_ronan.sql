CREATE TABLE "trigger_code_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"trigger_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_code_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_code_operations" (
	"organization_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"operation_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "trigger_code_operations_run_id_operation_id_pk" PRIMARY KEY("run_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "trigger_code_runners" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_code_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"trigger_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"document" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_code_state" (
	"organization_id" text NOT NULL,
	"trigger_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state_key" text NOT NULL,
	"owner_run_id" uuid,
	"document" jsonb NOT NULL,
	CONSTRAINT "trigger_code_state_trigger_id_kind_state_key_pk" PRIMARY KEY("trigger_id","kind","state_key")
);
--> statement-breakpoint
ALTER TABLE "organization_triggers" DROP CONSTRAINT "organization_triggers_format_check";--> statement-breakpoint
ALTER TABLE "trigger_code_events" ADD CONSTRAINT "trigger_code_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_events" ADD CONSTRAINT "trigger_code_events_trigger_id_organization_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."organization_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_logs" ADD CONSTRAINT "trigger_code_logs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_logs" ADD CONSTRAINT "trigger_code_logs_run_id_trigger_code_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trigger_code_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_operations" ADD CONSTRAINT "trigger_code_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_operations" ADD CONSTRAINT "trigger_code_operations_run_id_trigger_code_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."trigger_code_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_runners" ADD CONSTRAINT "trigger_code_runners_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_runs" ADD CONSTRAINT "trigger_code_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_runs" ADD CONSTRAINT "trigger_code_runs_trigger_id_organization_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."organization_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_runs" ADD CONSTRAINT "trigger_code_runs_revision_id_organization_trigger_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."organization_trigger_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_state" ADD CONSTRAINT "trigger_code_state_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_state" ADD CONSTRAINT "trigger_code_state_trigger_id_organization_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."organization_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_code_state" ADD CONSTRAINT "trigger_code_state_owner_run_id_trigger_code_runs_id_fk" FOREIGN KEY ("owner_run_id") REFERENCES "public"."trigger_code_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_code_events_delivery_unique" ON "trigger_code_events" USING btree ("trigger_id","delivery_id");--> statement-breakpoint
CREATE INDEX "trigger_code_events_trigger_sequence_idx" ON "trigger_code_events" USING btree ("trigger_id","sequence");--> statement-breakpoint
CREATE INDEX "trigger_code_logs_run_created_idx" ON "trigger_code_logs" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_code_runners_name_unique" ON "trigger_code_runners" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_code_runners_token_unique" ON "trigger_code_runners" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "trigger_code_runs_organization_created_idx" ON "trigger_code_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "trigger_code_runs_status_idx" ON "trigger_code_runs" USING btree ("status");--> statement-breakpoint
ALTER TABLE "organization_triggers" ADD CONSTRAINT "organization_triggers_format_check" CHECK ("organization_triggers"."format" in ('single_run', 'legacy_multistep', 'code'));