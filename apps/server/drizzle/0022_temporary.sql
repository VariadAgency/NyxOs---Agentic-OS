CREATE TABLE "temporary_marks" (
	"tmux_name" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "temporary_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"hours" integer DEFAULT 6 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "haiku_threads" ADD COLUMN "temporary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "temporary_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "temporary_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "temporary_kept" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "archived_at" timestamp with time zone;