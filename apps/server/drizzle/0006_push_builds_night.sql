CREATE TABLE "build_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_key" text,
	"kind" text NOT NULL,
	"command" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"exit_code" integer,
	"log_excerpt" text,
	"derived_data_path" text,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "night_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"title" text NOT NULL,
	"runs_on" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"session_key" text,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"stop_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"session_key" text,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"priority" text NOT NULL,
	"click_url" text,
	"bundled_count" integer DEFAULT 1 NOT NULL,
	"suppressed_reason" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"topic" text NOT NULL,
	"quiet_start" text DEFAULT '22:00' NOT NULL,
	"quiet_end" text DEFAULT '08:00' NOT NULL,
	"bundle_window_seconds" integer DEFAULT 120 NOT NULL,
	"waiting_after_seconds" integer DEFAULT 120 NOT NULL,
	"public_base_url" text DEFAULT 'http://127.0.0.1:47801' NOT NULL,
	"enabled_kinds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_runs" ADD CONSTRAINT "build_runs_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_log" ADD CONSTRAINT "push_log_session_key_sessions_id_fk" FOREIGN KEY ("session_key") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "build_runs_session_idx" ON "build_runs" USING btree ("session_key","started_at");--> statement-breakpoint
CREATE INDEX "build_runs_kind_status_idx" ON "build_runs" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "night_runs_status_idx" ON "night_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "push_log_kind_session_idx" ON "push_log" USING btree ("kind","session_key","sent_at");