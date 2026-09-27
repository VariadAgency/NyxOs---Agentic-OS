CREATE TABLE "archive" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"tool" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"gz_size" bigint NOT NULL,
	"stored_path" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "machines_name_unique" UNIQUE("name"),
	CONSTRAINT "machines_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_key" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_files" (
	"session_key" text NOT NULL,
	"path" text NOT NULL,
	"mode" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_files_session_key_path_mode_pk" PRIMARY KEY("session_key","path","mode")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tool" text NOT NULL,
	"session_id" text NOT NULL,
	"machine_id" text,
	"parent_id" text,
	"title" text,
	"title_source" text,
	"status" text DEFAULT 'running' NOT NULL,
	"cwd" text,
	"git_branch" text,
	"cli_version" text,
	"started_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tokens" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tokens_total" bigint DEFAULT 0 NOT NULL,
	"tool_calls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subagents" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"limits" jsonb,
	"parsed_event_count" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"parse_errors" integer DEFAULT 0 NOT NULL,
	"state_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "archive" ADD CONSTRAINT "archive_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_files" ADD CONSTRAINT "session_files_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "archive_tool_path_idx" ON "archive" USING btree ("tool","path");--> statement-breakpoint
CREATE INDEX "archive_session_idx" ON "archive" USING btree ("session_key");--> statement-breakpoint
CREATE INDEX "session_events_session_ts_idx" ON "session_events" USING btree ("session_key","ts");--> statement-breakpoint
CREATE INDEX "session_files_path_idx" ON "session_files" USING btree ("path");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_tool_session_id_idx" ON "sessions" USING btree ("tool","session_id");--> statement-breakpoint
CREATE INDEX "sessions_last_activity_idx" ON "sessions" USING btree ("last_activity_at");