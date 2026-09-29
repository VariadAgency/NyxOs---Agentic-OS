CREATE TABLE "session_state_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"crashed_max_hours" integer DEFAULT 12 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_runs" ADD COLUMN "folder" text;