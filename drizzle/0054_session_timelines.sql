CREATE TABLE "agent_session_timeline_rows" (
	"session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "agent_session_timeline_rows_session_id_seq_pk" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "agent_session_timelines" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_session_timeline_rows" ADD CONSTRAINT "agent_session_timeline_rows_session_id_agent_session_timelines_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_session_timelines"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_session_timelines" ADD CONSTRAINT "agent_session_timelines_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;