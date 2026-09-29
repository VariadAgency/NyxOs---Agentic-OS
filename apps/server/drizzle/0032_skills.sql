CREATE TABLE "skill_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"skill_key" text,
	"suggestion_id" integer,
	"model" text NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"session_key" text,
	"tmux_name" text,
	"backup_dir" text,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_scan_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_received_at" timestamp with time zone,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skill_suggestions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_key" text NOT NULL,
	"session_key" text,
	"event_id" text,
	"signal" text NOT NULL,
	"problem" text NOT NULL,
	"evidence" text NOT NULL,
	"idea" text NOT NULL,
	"author" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"job_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_uses" (
	"event_id" text PRIMARY KEY NOT NULL,
	"skill" text NOT NULL,
	"session_key" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"via" text NOT NULL,
	"tool_use_id" text,
	"checked_at" timestamp with time zone,
	"signal" text
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_key" text NOT NULL,
	"sha256" text NOT NULL,
	"content" text NOT NULL,
	"reason" text NOT NULL,
	"job_id" integer,
	"backup_dir" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"plugin" text,
	"dir" text,
	"skill_path" text,
	"writable" boolean DEFAULT false NOT NULL,
	"sha256" text,
	"bytes" integer DEFAULT 0 NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_since" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_suggestions_event_idx" ON "skill_suggestions" USING btree ("skill_key","event_id");--> statement-breakpoint
CREATE INDEX "skill_suggestions_skill_idx" ON "skill_suggestions" USING btree ("skill_key","status");--> statement-breakpoint
CREATE INDEX "skill_uses_skill_ts_idx" ON "skill_uses" USING btree ("skill","ts");--> statement-breakpoint
CREATE INDEX "skill_uses_unchecked_idx" ON "skill_uses" USING btree ("ts") WHERE "skill_uses"."checked_at" is null;--> statement-breakpoint
CREATE INDEX "skill_versions_skill_idx" ON "skill_versions" USING btree ("skill_key","id");--> statement-breakpoint
CREATE INDEX "session_events_skill_scan_idx" ON "session_events" USING btree ("received_at") WHERE ("session_events"."kind" = 'tool_call' and "session_events"."data"->>'name' = 'Skill') or ("session_events"."kind" = 'prompt' and "session_events"."data" ? 'command');
